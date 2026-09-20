import struct, json, os, subprocess

input_glb = 'public/models/spce_esb_isolated_full_quality_raw.glb'
output_glb = 'public/models/spce_esb_isolated_full_quality_pbr.glb'
bmp_dir = '/tmp/isolated_tile_bmps'
pbr_dir = '/tmp/isolated_tile_pbr'
jpeg_dir = '/tmp/isolated_tile_jpegs'

os.makedirs(bmp_dir, exist_ok=True)
os.makedirs(pbr_dir, exist_ok=True)
os.makedirs(jpeg_dir, exist_ok=True)

with open(input_glb, 'rb') as f:
    magic, version, total_len = struct.unpack('<III', f.read(12))
    chunk0_len, chunk0_type = struct.unpack('<II', f.read(8))
    json_bytes = f.read(chunk0_len)
    data = json.loads(json_bytes.decode('utf-8'))
    chunk1_len, chunk1_type = struct.unpack('<II', f.read(8))
    bin_data = bytearray(f.read(chunk1_len))

images = data.get('images', [])
buffer_views = data.get('bufferViews', [])
num_images = len(images)
print(f"Extracting {num_images} authentic photogrammetry images from isolated GLB...")

first_img_bv = min(img['bufferView'] for img in images)
geom_bv_count = first_img_bv
geom_end_offset = 0
for i in range(geom_bv_count):
    bv = buffer_views[i]
    end = bv.get('byteOffset', 0) + bv['byteLength']
    if end > geom_end_offset:
        geom_end_offset = end

geom_end_offset = (geom_end_offset + 3) & ~3
print(f"Geometry binary size: {geom_end_offset} bytes ({geom_end_offset/1024/1024:.2f} MB)")

for i, img_info in enumerate(images):
    bv = buffer_views[img_info['bufferView']]
    offset = bv.get('byteOffset', 0)
    length = bv['byteLength']
    raw_img_bytes = bin_data[offset : offset + length]
    raw_path = f"/tmp/isolated_raw_{i:02d}.jpg"
    with open(raw_path, 'wb') as rf:
        rf.write(raw_img_bytes)
    
    bmp_path = f"{bmp_dir}/texture_{i:02d}.bmp"
    subprocess.run(['sips', '-s', 'format', 'bmp', raw_path, '--out', bmp_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

print(f"Running C++20 SIMD Bilateral De-Lighter & PBR Synthesizer...")
res = subprocess.run(['./scripts/process_authentic_tile_texture', bmp_dir, pbr_dir], capture_output=True, text=True)
print(res.stdout)
if res.returncode != 0:
    print(res.stderr)
    raise SystemError("C++ texture processing failed!")

print(f"Converting PBR channel maps to JPEGs via sips...")
for i in range(num_images):
    stem = f"texture_{i:02d}"
    subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '92', f"{pbr_dir}/{stem}_albedo.png", '--out', f"{jpeg_dir}/{stem}_albedo.jpg"], stdout=subprocess.DEVNULL, check=True)
    subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '90', f"{pbr_dir}/{stem}_normal.png", '--out', f"{jpeg_dir}/{stem}_normal.jpg"], stdout=subprocess.DEVNULL, check=True)
    subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '90', f"{pbr_dir}/{stem}_roughness.png", '--out', f"{jpeg_dir}/{stem}_roughness.jpg"], stdout=subprocess.DEVNULL, check=True)

# Build PBR GLB
new_buffer_views = data['bufferViews'][:geom_bv_count]
new_bin_data = bytearray(bin_data[:geom_end_offset])
new_images = []
new_textures = []

# 1. Albedo maps
albedo_tex_indices = []
for i in range(num_images):
    with open(f"{jpeg_dir}/texture_{i:02d}_albedo.jpg", 'rb') as img_f:
        b = img_f.read()
    offset = len(new_bin_data)
    new_bin_data.extend(b)
    padding = (4 - (len(new_bin_data) % 4)) % 4
    new_bin_data.extend(b'\x00' * padding)
    bv_idx = len(new_buffer_views)
    new_buffer_views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(b)})
    img_idx = len(new_images)
    new_images.append({'mimeType': 'image/jpeg', 'bufferView': bv_idx})
    tex_idx = len(new_textures)
    new_textures.append({'source': img_idx})
    albedo_tex_indices.append(tex_idx)

# 2. Normal maps
normal_tex_indices = []
for i in range(num_images):
    with open(f"{jpeg_dir}/texture_{i:02d}_normal.jpg", 'rb') as img_f:
        b = img_f.read()
    offset = len(new_bin_data)
    new_bin_data.extend(b)
    padding = (4 - (len(new_bin_data) % 4)) % 4
    new_bin_data.extend(b'\x00' * padding)
    bv_idx = len(new_buffer_views)
    new_buffer_views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(b)})
    img_idx = len(new_images)
    new_images.append({'mimeType': 'image/jpeg', 'bufferView': bv_idx})
    tex_idx = len(new_textures)
    new_textures.append({'source': img_idx})
    normal_tex_indices.append(tex_idx)

# 3. Roughness maps
roughness_tex_indices = []
for i in range(num_images):
    with open(f"{jpeg_dir}/texture_{i:02d}_roughness.jpg", 'rb') as img_f:
        b = img_f.read()
    offset = len(new_bin_data)
    new_bin_data.extend(b)
    padding = (4 - (len(new_bin_data) % 4)) % 4
    new_bin_data.extend(b'\x00' * padding)
    bv_idx = len(new_buffer_views)
    new_buffer_views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(b)})
    img_idx = len(new_images)
    new_images.append({'mimeType': 'image/jpeg', 'bufferView': bv_idx})
    tex_idx = len(new_textures)
    new_textures.append({'source': img_idx})
    roughness_tex_indices.append(tex_idx)

# Update Materials
new_materials = []
for i in range(len(data['materials'])):
    mat = data['materials'][i]
    pbr = mat.get('pbrMetallicRoughness', {})
    pbr['baseColorTexture'] = {'index': albedo_tex_indices[i]}
    pbr['roughnessFactor'] = 0.85
    pbr['metallicFactor'] = 0.12
    pbr['metallicRoughnessTexture'] = {'index': roughness_tex_indices[i]}
    mat['pbrMetallicRoughness'] = pbr
    mat['normalTexture'] = {'index': normal_tex_indices[i], 'scale': 1.6}
    mat['doubleSided'] = True
    new_materials.append(mat)

data['bufferViews'] = new_buffer_views
data['images'] = new_images
data['textures'] = new_textures
data['materials'] = new_materials
data['buffers'][0]['byteLength'] = len(new_bin_data)

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

print(f"SUCCESS: Created {output_glb} ({total_length / 1024 / 1024:.2f} MB, {num_images} PBR materials, {num_images*3} texture channels)")
