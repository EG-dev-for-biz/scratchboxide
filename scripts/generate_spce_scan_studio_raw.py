import struct, json, os

os.makedirs('public/models', exist_ok=True)
input_glb = 'public/tiles/scan_studio_tile_77205_98511.glb'
output_glb = 'public/models/spce_scan_studio_raw_tile.glb'

with open(input_glb, 'rb') as f:
    magic, version, total_len = struct.unpack('<III', f.read(12))
    chunk0_len, chunk0_type = struct.unpack('<II', f.read(8))
    json_bytes = f.read(chunk0_len)
    data = json.loads(json_bytes.decode('utf-8'))
    chunk1_len, chunk1_type = struct.unpack('<II', f.read(8))
    bin_data = bytearray(f.read(chunk1_len))

# Calculate global bounds
all_min = [1e9, 1e9, 1e9]
all_max = [-1e9, -1e9, -1e9]

for m in data['meshes']:
    for prim in m['primitives']:
        pos_acc = data['accessors'][prim['attributes']['POSITION']]
        all_min = [min(all_min[i], pos_acc['min'][i]) for i in range(3)]
        all_max = [max(all_max[i], pos_acc['max'][i]) for i in range(3)]

center_x = (all_min[0] + all_max[0]) / 2.0
center_z = (all_min[2] + all_max[2]) / 2.0
bottom_y = all_min[1]

dx = -center_x
dy = -bottom_y
dz = -center_z

# Translate all POSITION accessors
visited_views = set()
for m in data['meshes']:
    for prim in m['primitives']:
        acc_idx = prim['attributes']['POSITION']
        pos_acc = data['accessors'][acc_idx]
        bv_idx = pos_acc['bufferView']
        bv = data['bufferViews'][bv_idx]
        offset = bv.get('byteOffset', 0) + pos_acc.get('byteOffset', 0)
        cnt = pos_acc['count']

        if bv_idx not in visited_views:
            visited_views.add(bv_idx)
            for i in range(cnt):
                byte_pos = offset + i * 12
                x, y, z = struct.unpack_from('<fff', bin_data, byte_pos)
                struct.pack_into('<fff', bin_data, byte_pos, x + dx, y + dy, z + dz)

        # Update min and max in accessor
        pos_acc['min'] = [pos_acc['min'][0] + dx, pos_acc['min'][1] + dy, pos_acc['min'][2] + dz]
        pos_acc['max'] = [pos_acc['max'][0] + dx, pos_acc['max'][1] + dy, pos_acc['max'][2] + dz]

# Re-encode JSON chunk
new_json_bytes = json.dumps(data, separators=(',', ':')).encode('utf-8')
# Pad JSON to 4-byte boundary
json_padding = (4 - (len(new_json_bytes) % 4)) % 4
new_json_bytes += b' ' * json_padding

# Pad binary buffer to 4-byte boundary
bin_padding = (4 - (len(bin_data) % 4)) % 4
bin_data += b'\x00' * bin_padding

# Update total length
total_file_len = 12 + 8 + len(new_json_bytes) + 8 + len(bin_data)

with open(output_glb, 'wb') as f:
    f.write(struct.pack('<III', magic, version, total_file_len))
    f.write(struct.pack('<II', len(new_json_bytes), chunk0_type))
    f.write(new_json_bytes)
    f.write(struct.pack('<II', len(bin_data), chunk1_type))
    f.write(bin_data)

print(f"SUCCESS: Created {output_glb} ({os.path.getsize(output_glb)/1024/1024:.2f} MB)")
