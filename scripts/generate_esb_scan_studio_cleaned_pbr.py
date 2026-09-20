import struct, json, os

input_glb = 'public/models/spce_scan_studio_raw_tile.glb'
output_glb = 'public/models/spce_scan_studio_cleaned_pbr.glb'
jpeg_dir = '/tmp/esb_tile_cleaned_jpegs'

with open(input_glb, 'rb') as f:
    magic, version, total_len = struct.unpack('<III', f.read(12))
    chunk0_len, chunk0_type = struct.unpack('<II', f.read(8))
    json_bytes = f.read(chunk0_len)
    data = json.loads(json_bytes.decode('utf-8'))
    chunk1_len, chunk1_type = struct.unpack('<II', f.read(8))
    bin_data = bytearray(f.read(chunk1_len))

num_images = len(data.get('images', []))
image_bvs = {img['bufferView'] for img in data.get('images', [])}
geom_bvs = [i for i in range(len(data.get('bufferViews', []))) if i not in image_bvs]

# Find max byte offset of geometry bufferViews
geom_end_offset = 0
for idx in geom_bvs:
    bv = data['bufferViews'][idx]
    end = bv.get('byteOffset', 0) + bv['byteLength']
    if end > geom_end_offset:
        geom_end_offset = end

geom_end_offset = (geom_end_offset + 3) & ~3
print(f"Geometry binary size: {geom_end_offset} bytes ({geom_end_offset/1024/1024:.2f} MB), {len(geom_bvs)} bufferViews")

# Keep only geometry bufferViews
new_buffer_views = [data['bufferViews'][i] for i in geom_bvs]
bv_map = {old_idx: new_idx for new_idx, old_idx in enumerate(geom_bvs)}

# Remap accessors to new bufferView indices
for acc in data.get('accessors', []):
    if 'bufferView' in acc:
        acc['bufferView'] = bv_map[acc['bufferView']]

new_bin_data = bytearray(bin_data[:geom_end_offset])

new_images = []
new_textures = []

# 1. Cleaned Albedo Maps (70)
for i in range(num_images):
    path = f"{jpeg_dir}/tile_tex_{i:03d}_albedo.jpg"
    with open(path, 'rb') as img_f:
        img_bytes = img_f.read()
    
    offset = len(new_bin_data)
    new_bin_data.extend(img_bytes)
    padding = (4 - (len(new_bin_data) % 4)) % 4
    new_bin_data.extend(b'\x00' * padding)
    
    bv_idx = len(new_buffer_views)
    new_buffer_views.append({
        'buffer': 0,
        'byteOffset': offset,
        'byteLength': len(img_bytes)
    })
    
    img_idx = len(new_images)
    new_images.append({
        'mimeType': 'image/jpeg',
        'bufferView': bv_idx
    })
    
    new_textures.append({
        'source': img_idx
    })

# 2. Synthesized Normal Maps (70)
for i in range(num_images):
    path = f"{jpeg_dir}/tile_tex_{i:03d}_normal.jpg"
    with open(path, 'rb') as img_f:
        img_bytes = img_f.read()
    
    offset = len(new_bin_data)
    new_bin_data.extend(img_bytes)
    padding = (4 - (len(new_bin_data) % 4)) % 4
    new_bin_data.extend(b'\x00' * padding)
    
    bv_idx = len(new_buffer_views)
    new_buffer_views.append({
        'buffer': 0,
        'byteOffset': offset,
        'byteLength': len(img_bytes)
    })
    
    img_idx = len(new_images)
    new_images.append({
        'mimeType': 'image/jpeg',
        'bufferView': bv_idx
    })
    
    new_textures.append({
        'source': img_idx
    })

# 3. Synthesized Roughness Maps (70)
for i in range(num_images):
    path = f"{jpeg_dir}/tile_tex_{i:03d}_roughness.jpg"
    with open(path, 'rb') as img_f:
        img_bytes = img_f.read()
    
    offset = len(new_bin_data)
    new_bin_data.extend(img_bytes)
    padding = (4 - (len(new_bin_data) % 4)) % 4
    new_bin_data.extend(b'\x00' * padding)
    
    bv_idx = len(new_buffer_views)
    new_buffer_views.append({
        'buffer': 0,
        'byteOffset': offset,
        'byteLength': len(img_bytes)
    })
    
    img_idx = len(new_images)
    new_images.append({
        'mimeType': 'image/jpeg',
        'bufferView': bv_idx
    })
    
    new_textures.append({
        'source': img_idx
    })

# Update materials to bind albedo, normal, and roughness textures
for i, mat in enumerate(data.get('materials', [])):
    albedo_tex_idx = i % num_images
    normal_tex_idx = num_images + (i % num_images)
    rough_tex_idx = (num_images * 2) + (i % num_images)
    
    pbr = mat.get('pbrMetallicRoughness', {})
    pbr['baseColorTexture'] = {'index': albedo_tex_idx}
    pbr['metallicRoughnessTexture'] = {'index': rough_tex_idx}
    pbr['metallicFactor'] = 0.05
    pbr['roughnessFactor'] = 0.85
    mat['pbrMetallicRoughness'] = pbr
    
    mat['normalTexture'] = {
        'index': normal_tex_idx,
        'scale': 1.6
    }

data['bufferViews'] = new_buffer_views
data['images'] = new_images
data['textures'] = new_textures
data['buffers'][0]['byteLength'] = len(new_bin_data)

# Reassemble binary glTF
new_json_bytes = json.dumps(data, separators=(',', ':')).encode('utf-8')
padding = (4 - (len(new_json_bytes) % 4)) % 4
new_json_bytes += b' ' * padding

chunk0_len = len(new_json_bytes)
chunk1_len = len(new_bin_data)
total_len = 12 + 8 + chunk0_len + 8 + chunk1_len

with open(output_glb, 'wb') as out_f:
    out_f.write(struct.pack('<III', magic, version, total_len))
    out_f.write(struct.pack('<II', chunk0_len, 0x4E4F534A)) # JSON
    out_f.write(new_json_bytes)
    out_f.write(struct.pack('<II', chunk1_len, 0x004E4942)) # BIN
    out_f.write(new_bin_data)

print(f"SUCCESS: Generated {output_glb} ({total_len/1024/1024:.2f} MB)")
