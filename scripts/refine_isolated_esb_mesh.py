import struct, json, os, sys

input_glb = 'public/models/spce_scan_studio_raw_tile.glb'
output_glb = 'public/models/spce_esb_isolated_full_quality_raw.glb'

with open(input_glb, 'rb') as f:
    magic, version, total_len = struct.unpack('<III', f.read(12))
    chunk0_len, chunk0_type = struct.unpack('<II', f.read(8))
    json_bytes = f.read(chunk0_len)
    data = json.loads(json_bytes.decode('utf-8'))
    chunk1_len, chunk1_type = struct.unpack('<II', f.read(8))
    bin_data = bytearray(f.read(chunk1_len))

accessors = data['accessors']
buffer_views = data['bufferViews']

def get_buffer_data(acc_idx):
    acc = accessors[acc_idx]
    bv = buffer_views[acc['bufferView']]
    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    return bv, offset, count

def is_esb_perfect(p0, p1, p2):
    cx = (p0[0] + p1[0] + p2[0]) / 3
    cy = (p0[1] + p1[1] + p2[1]) / 3
    cz = (p0[2] + p1[2] + p2[2]) / 3
    
    min_x = min(p0[0], p1[0], p2[0])
    max_x = max(p0[0], p1[0], p2[0])
    min_y = min(p0[1], p1[1], p2[1])
    max_y = max(p0[1], p1[1], p2[1])
    min_z = min(p0[2], p1[2], p2[2])
    max_z = max(p0[2], p1[2], p2[2])
    
    # 1. Height datum: keep building from ground datum to spire tip
    if max_y < 0.0 or min_y > 430.0:
        return False
        
    # 2. Hard block boundary (5th Ave lot: X in [-65.5, 36.0], 33rd/34th St lot: Z in [-37.5, 37.0])
    if min_x < -65.5 or max_x > 36.0:
        return False
    if min_z < -37.5 or max_z > 37.0:
        return False
        
    # 3. Ground skirt check: prune downward ground skirt stretching into street
    e01 = ((p0[0]-p1[0])**2 + (p0[1]-p1[1])**2 + (p0[2]-p1[2])**2)**0.5
    e12 = ((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2 + (p1[2]-p2[2])**2)**0.5
    e20 = ((p2[0]-p0[0])**2 + (p2[1]-p0[1])**2 + (p2[2]-p0[2])**2)**0.5
    max_edge = max(e01, e12, e20)
    if min_y < 1.0 and max_edge > 6.0:
        return False

    # 4. Architectural setback envelope (Block 835 parcel geometry)
    if cy > 330.0:
        return (abs(cx) <= 18.0 and abs(cz) <= 18.0)
    elif cy > 250.0:
        return (abs(cx) <= 32.5 and -28.5 <= cz <= 28.0)
    elif cy > 86.0:
        return (-36.5 <= cx <= 35.5 and -31.5 <= cz <= 31.0)
    elif cy > 28.0:
        # Floors 6-20 setback terrace: strictly exclude adjacent 12-story west neighbor building
        return (-40.0 <= cx <= 35.5 and -34.0 <= cz <= 34.0 and min_x >= -41.0)
    else:
        # 5-story podium base along 5th Ave
        return (-65.5 <= cx <= 35.5 and -37.5 <= cz <= 37.0)

new_bin_data = bytearray()
new_buffer_views = []
new_accessors = []
new_meshes = []

total_kept_tris = 0
used_materials = set()

for m_idx, mesh in enumerate(data['meshes']):
    new_primitives = []
    for prim in mesh['primitives']:
        pos_acc_idx = prim['attributes']['POSITION']
        norm_acc_idx = prim['attributes'].get('NORMAL')
        uv_acc_idx = prim['attributes'].get('TEXCOORD_0')

        _, pos_offset, vert_count = get_buffer_data(pos_acc_idx)
        positions = [struct.unpack_from('<3f', bin_data, pos_offset + i*12) for i in range(vert_count)]

        normals = None
        if norm_acc_idx is not None:
            _, norm_offset, _ = get_buffer_data(norm_acc_idx)
            normals = [struct.unpack_from('<3f', bin_data, norm_offset + i*12) for i in range(vert_count)]

        uvs = None
        if uv_acc_idx is not None:
            _, uv_offset, _ = get_buffer_data(uv_acc_idx)
            uvs = [struct.unpack_from('<2f', bin_data, uv_offset + i*8) for i in range(vert_count)]

        kept_pos = []
        kept_norm = []
        kept_uv = []

        tri_count = vert_count // 3
        for t in range(tri_count):
            p0, p1, p2 = positions[t*3], positions[t*3+1], positions[t*3+2]
            if is_esb_perfect(p0, p1, p2):
                kept_pos.extend([p0, p1, p2])
                if normals:
                    kept_norm.extend([normals[t*3], normals[t*3+1], normals[t*3+2]])
                if uvs:
                    kept_uv.extend([uvs[t*3], uvs[t*3+1], uvs[t*3+2]])

        if len(kept_pos) > 0:
            k_verts = len(kept_pos)
            total_kept_tris += k_verts // 3
            mat_idx = prim.get('material', 0)
            used_materials.add(mat_idx)

            pos_bytes = bytearray()
            min_v = [float('inf')]*3
            max_v = [float('-inf')]*3
            for v in kept_pos:
                pos_bytes.extend(struct.pack('<3f', *v))
                for c in range(3):
                    min_v[c] = min(min_v[c], v[c])
                    max_v[c] = max(max_v[c], v[c])

            pos_offset = len(new_bin_data)
            new_bin_data.extend(pos_bytes)
            pos_pad = (4 - (len(new_bin_data) % 4)) % 4
            new_bin_data.extend(b'\x00' * pos_pad)

            pos_bv_idx = len(new_buffer_views)
            new_buffer_views.append({'buffer': 0, 'byteOffset': pos_offset, 'byteLength': len(pos_bytes)})
            pos_acc = len(new_accessors)
            new_accessors.append({
                'bufferView': pos_bv_idx,
                'byteOffset': 0,
                'componentType': 5126,
                'count': k_verts,
                'type': 'VEC3',
                'min': min_v,
                'max': max_v
            })

            new_attributes = {'POSITION': pos_acc}

            if normals and len(kept_norm) > 0:
                norm_bytes = bytearray()
                for n in kept_norm:
                    norm_bytes.extend(struct.pack('<3f', *n))
                norm_offset = len(new_bin_data)
                new_bin_data.extend(norm_bytes)
                norm_pad = (4 - (len(new_bin_data) % 4)) % 4
                new_bin_data.extend(b'\x00' * norm_pad)

                norm_bv_idx = len(new_buffer_views)
                new_buffer_views.append({'buffer': 0, 'byteOffset': norm_offset, 'byteLength': len(norm_bytes)})
                norm_acc = len(new_accessors)
                new_accessors.append({
                    'bufferView': norm_bv_idx,
                    'byteOffset': 0,
                    'componentType': 5126,
                    'count': k_verts,
                    'type': 'VEC3'
                })
                new_attributes['NORMAL'] = norm_acc

            if uvs and len(kept_uv) > 0:
                uv_bytes = bytearray()
                for u in kept_uv:
                    uv_bytes.extend(struct.pack('<2f', *u))
                uv_offset = len(new_bin_data)
                new_bin_data.extend(uv_bytes)
                uv_pad = (4 - (len(new_bin_data) % 4)) % 4
                new_bin_data.extend(b'\x00' * uv_pad)

                uv_bv_idx = len(new_buffer_views)
                new_buffer_views.append({'buffer': 0, 'byteOffset': uv_offset, 'byteLength': len(uv_bytes)})
                uv_acc = len(new_accessors)
                new_accessors.append({
                    'bufferView': uv_bv_idx,
                    'byteOffset': 0,
                    'componentType': 5126,
                    'count': k_verts,
                    'type': 'VEC2'
                })
                new_attributes['TEXCOORD_0'] = uv_acc

            new_prim = {
                'attributes': new_attributes,
                'material': mat_idx
            }
            new_primitives.append(new_prim)

    if new_primitives:
        mesh_name = mesh.get('name', f'ESB_Mesh_{m_idx}')
        new_mesh = {'name': mesh_name, 'primitives': new_primitives}
        new_meshes.append(new_mesh)

print(f"Refined ESB: {len(new_meshes)} meshes, {total_kept_tris:,} triangles across {len(used_materials)} authentic materials")

# Append images
new_images = []
for i, img in enumerate(data.get('images', [])):
    old_bv = buffer_views[img['bufferView']]
    img_data = bin_data[old_bv['byteOffset'] : old_bv['byteOffset'] + old_bv['byteLength']]
    img_off = len(new_bin_data)
    new_bin_data.extend(img_data)
    img_pad = (4 - (len(new_bin_data) % 4)) % 4
    new_bin_data.extend(b'\x00' * img_pad)

    bv_idx = len(new_buffer_views)
    new_buffer_views.append({'buffer': 0, 'byteOffset': img_off, 'byteLength': len(img_data)})
    new_images.append({'mimeType': img['mimeType'], 'bufferView': bv_idx})

data['accessors'] = new_accessors
data['bufferViews'] = new_buffer_views
data['meshes'] = new_meshes
data['images'] = new_images
data['buffers'][0]['byteLength'] = len(new_bin_data)

data['nodes'] = [{'mesh': i, 'name': m['name']} for i, m in enumerate(new_meshes)]
data['scenes'] = [{'nodes': list(range(len(new_meshes)))}]

new_json_bytes = json.dumps(data, separators=(',', ':')).encode('utf-8')
new_json_padding = (4 - (len(new_json_bytes) % 4)) % 4
new_json_bytes += b' ' * new_json_padding

bin_padding = (4 - (len(new_bin_data) % 4)) % 4
new_bin_data += b'\x00' * bin_padding

total_length = 12 + 8 + len(new_json_bytes) + 8 + len(new_bin_data)

with open(output_glb, 'wb') as f:
    f.write(struct.pack('<III', magic, version, total_length))
    f.write(struct.pack('<II', len(new_json_bytes), chunk0_type))
    f.write(new_json_bytes)
    f.write(struct.pack('<II', len(new_bin_data), chunk1_type))
    f.write(new_bin_data)

print(f"Saved refined GLB: {output_glb} ({total_length/1024/1024:.2f} MB)")
