import struct, json, os

with open('public/tiles/scan_studio_tile_77205_98511.glb', 'rb') as f:
    f.read(12)
    chunk_len, chunk_type = struct.unpack('<II', f.read(8))
    data = json.loads(f.read(chunk_len).decode('utf-8'))
    chunk_len2, chunk_type2 = struct.unpack('<II', f.read(8))
    bin_data = bytearray(f.read(chunk_len2))

# Find global bounds
all_min = [1e9, 1e9, 1e9]
all_max = [-1e9, -1e9, -1e9]

for m in data['meshes']:
    for prim in m['primitives']:
        pos_acc = data['accessors'][prim['attributes']['POSITION']]
        all_min = [min(all_min[i], pos_acc['min'][i]) for i in range(3)]
        all_max = [max(all_max[i], pos_acc['max'][i]) for i in range(3)]

print(f"Global bounds: min={all_min}, max={all_max}")
center_x = (all_min[0] + all_max[0]) / 2.0
center_z = (all_min[2] + all_max[2]) / 2.0
bottom_y = all_min[1]
print(f"Offset translation: dx={-center_x:.3f}, dy={-bottom_y:.3f}, dz={-center_z:.3f}")
