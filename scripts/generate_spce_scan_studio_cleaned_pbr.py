import struct, json, os

input_glb = 'public/models/spce_scan_studio_raw_tile.glb'
output_glb = 'public/models/spce_scan_studio_cleaned_pbr.glb'
jpeg_dir = '/tmp/tile_cleaned_jpegs'

with open(input_glb, 'rb') as f:
    magic, version, total_len = struct.unpack('<III', f.read(12))
    chunk0_len, chunk0_type = struct.unpack('<II', f.read(8))
    json_bytes = f.read(chunk0_len)
    data = json.loads(json_bytes.decode('utf-8'))
    chunk1_len, chunk1_type = struct.unpack('<II', f.read(8))
    bin_data = bytearray(f.read(chunk1_len))

# In the raw GLB, bufferViews 0..331 are geometry (332 total).
# BufferViews 332..414 were the original 83 raw textures.
# We will truncate bin_data to only include geometry buffers!
geom_bv_count = 332
geom_end_offset = 0
for i in range(geom_bv_count):
    bv = data['bufferViews'][i]
    end = bv.get('byteOffset', 0) + bv['byteLength']
    if end > geom_end_offset:
        geom_end_offset = end

# Align to 4 bytes
geom_end_offset = (geom_end_offset + 3) & ~3
print(f"Geometry binary size: {geom_end_offset} bytes ({geom_end_offset/1024/1024:.2f} MB)")

# Truncate bufferViews to keep only geometry
new_buffer_views = data['bufferViews'][:geom_bv_count]
new_bin_data = bytearray(bin_data[:geom_end_offset])

new_images = []
new_textures = []

# 1. Append Cleaned Albedo Maps (83)
for i in range(83):
    path = f"{jpeg_dir}/texture_{i:02d}_albedo.jpg"
    with open(path, 'rb') as img_f:
        img_bytes = img_f.read()
    
    # 4-byte align
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

# 2. Append Synthesized Normal Maps (83)
for i in range(83):
    path = f"{jpeg_dir}/texture_{i:02d}_normal.jpg"
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

# 3. Append Synthesized Roughness Maps (83)
for i in range(83):
    path = f"{jpeg_dir}/texture_{i:02d}_roughness.jpg"
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

# Update Materials
for i in range(len(data['materials'])):
    mat = data['materials'][i]
    pbr = mat.get('pbrMetallicRoughness', {})
    # Base color texture (0..82)
    pbr['baseColorTexture'] = {'index': i}
    pbr['roughnessFactor'] = 0.85
    pbr['metallicFactor'] = 0.12
    # Metallic roughness texture (166..248)
    pbr['metallicRoughnessTexture'] = {'index': 166 + i}
    mat['pbrMetallicRoughness'] = pbr
    # Normal texture (83..165)
    mat['normalTexture'] = {'index': 83 + i, 'scale': 1.6}
    mat['doubleSided'] = True

data['bufferViews'] = new_buffer_views
data['images'] = new_images
data['textures'] = new_textures
data['buffers'][0]['byteLength'] = len(new_bin_data)

# Re-encode JSON chunk
new_json_bytes = json.dumps(data, separators=(',', ':')).encode('utf-8')
json_padding = (4 - (len(new_json_bytes) % 4)) % 4
new_json_bytes += b' ' * json_padding

bin_padding = (4 - (len(new_bin_data) % 4)) % 4
new_bin_data += b'\x00' * bin_padding

total_file_len = 12 + 8 + len(new_json_bytes) + 8 + len(new_bin_data)

with open(output_glb, 'wb') as f:
    f.write(struct.pack('<III', magic, version, total_file_len))
    f.write(struct.pack('<II', len(new_json_bytes), chunk0_type))
    f.write(new_json_bytes)
    f.write(struct.pack('<II', len(new_bin_data), chunk1_type))
    f.write(new_bin_data)

print(f"SUCCESS: Created {output_glb} ({os.path.getsize(output_glb)/1024/1024:.2f} MB)")
