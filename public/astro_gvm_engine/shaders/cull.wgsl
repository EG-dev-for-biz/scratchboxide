struct ClusterBounds {
                    sphere: vec4<f32>,
                    cone: vec4<f32>,
                };

                struct CameraUniforms {
                    viewProj: mat4x4<f32>,
                    camPos: vec4<f32>,
                    planes: array<vec4<f32>, 6>,
                    cullingParams: vec4<f32>, // x: frustumOn, y: coneOn, z: viewMode, w: totalCount
                };

                // DrawIndirectArgs (VkDrawIndirectCommand):
                // vertexCount, instanceCount, firstVertex, firstInstance
                struct DrawIndirectArgs {
                    vertexCount: u32,
                    instanceCount: atomic<u32>,
                    firstVertex: u32,
                    firstInstance: u32,
                };

                @group(0) @binding(0) var<uniform> camera: CameraUniforms;
                @group(0) @binding(1) var<storage, read> bounds: array<ClusterBounds>;
                @group(0) @binding(2) var<storage, read_write> drawArgs: DrawIndirectArgs;
                @group(0) @binding(3) var<storage, read_write> visibleClusterIDs: array<u32>;

                @compute @workgroup_size(64, 1, 1)
                fn cs_cull(@builtin(global_invocation_id) id: vec3<u32>) {
                    let clusterIdx = id.x;
                    if (clusterIdx >= u32(camera.cullingParams.w)) {
                        return;
                    }

                    let b = bounds[clusterIdx];

                    // 1. Frustum Culling
                    if (camera.cullingParams.x > 0.5) {
                        for (var p = 0u; p < 6u; p = p + 1u) {
                            let plane = camera.planes[p];
                            let dist = dot(plane.xyz, b.sphere.xyz) + plane.w;
                            if (dist < -b.sphere.w) {
                                return; // Fully outside frustum
                            }
                        }
                    }

                    // 2. Normal Cone Backface Culling
                    if (camera.cullingParams.y > 0.5) {
                        let toCam = normalize(camera.camPos.xyz - b.sphere.xyz);
                        if (dot(b.cone.xyz, toCam) < b.cone.w) {
                            return; // Backfacing cluster
                        }
                    }

                    // Survived: Atomic compaction into visible queue
                    let slot = atomicAdd(&drawArgs.instanceCount, 1u);
                    visibleClusterIDs[slot] = clusterIdx;
                }