#include "scratchbox_engine.hpp" // Assuming this provides necessary 3D primitives and utilities
#include <vector>
#include <random>
#include <glm/glm.hpp> // For vector and matrix operations
#include <glm/gtc/noise.hpp> // For Perlin noise
#include <iostream> // For basic logging

// Structure to hold asteroid properties
struct Asteroid {
    glm::vec3 position;
    glm::vec3 rotation;
    glm::vec3 scale;
    // Add more properties like velocity, angular velocity, material, etc.
};

// Function to generate a single asteroid mesh using an icosphere and noise displacement
scratchbox::Mesh generateAsteroidMesh(float baseRadius, int subdivisions, float irregularity) {
    scratchbox::Mesh mesh;
    std::vector<scratchbox::Vertex> vertices;
    std::vector<unsigned int> indices;

    // --- Icosphere generation (simplified for brevity, a full implementation is complex) ---
    // Start with a basic octahedron (20 triangles for an icosahedron, simpler for an octahedron)
    // For a real icosphere, you'd subdivide a 20-sided icosahedron.
    // Here, we'll simulate a very basic sphere for displacement.

    // A more robust implementation would involve:
    // 1. Create an icosahedron (12 vertices, 20 faces).
    // 2. Subdivide each triangle face into 4 new triangles, pushing new vertices to the sphere surface.
    // 3. Repeat subdivision for desired 'subdivisions' level.
    // 4. Normalize all vertices to lie on the surface of a sphere.

    // Placeholder for a simple sphere-like shape for now
    // Create a basic "sphere" by generating points on a sphere and triangulating them
    // This is NOT a proper icosphere but serves to demonstrate displacement.
    const int stacks = 10;
    const int slices = 10;
    for (int i = 0; i <= stacks; ++i) {
        float V = i / (float)stacks;
        float phi = V * glm::pi<float>(); // 0 to PI

        for (int j = 0; j <= slices; ++j) {
            float U = j / (float)slices;
            float theta = U * (glm::pi<float>() * 2.0f); // 0 to 2*PI

            float x = cos(theta) * sin(phi);
            float y = cos(phi);
            float z = sin(theta) * sin(phi);

            glm::vec3 normal = glm::normalize(glm::vec3(x, y, z));
            glm::vec3 position = normal * baseRadius;

            vertices.push_back({position, normal, {U, V}});
        }
    }

    // Generate indices for the sphere (simplified)
    for (int i = 0; i < stacks; ++i) {
        for (int j = 0; j < slices; ++j) {
            int p1 = i * (slices + 1) + j;
            int p2 = p1 + (slices + 1);
            int p3 = p2 + 1;
            int p4 = p1 + 1;

            if (i != 0) { // Avoid top cap issues
                indices.push_back(p1);
                indices.push_back(p2);
                indices.push_back(p4);
            }
            if (i != (stacks - 1)) { // Avoid bottom cap issues
                indices.push_back(p4);
                indices.push_back(p2);
                indices.push_back(p3);
            }
        }
    }

    // --- Noise Displacement ---
    // Apply Perlin noise to displace vertices
    for (auto& vertex : vertices) {
        // Use vertex position for noise sampling, scaled by irregularity
        float noise = glm::perlin(vertex.position * irregularity);
        // Displace along the normal
        vertex.position += vertex.normal * noise * (baseRadius * 0.2f); // 20% of radius displacement
    }

    // After displacement, normals might need recalculation for accurate lighting
    // For simplicity, we'll keep the original sphere normals for now,
    // but a proper implementation would re-calculate per-face or averaged vertex normals.

    mesh.setVertices(vertices);
    mesh.setIndices(indices);
    // mesh.calculateNormals(); // Assuming scratchbox::Mesh has this utility

    return mesh;
}

// Main function to generate the asteroid field scene
scratchbox::SceneData generateAsteroidFieldScene(int numberOfAsteroids, float fieldRadius) {
    scratchbox::SceneData scene;

    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_real_distribution<> dis_pos(-fieldRadius, fieldRadius);
    std::uniform_real_distribution<> dis_scale(0.5, 3.0); // Asteroid scale factor
    std::uniform_real_distribution<> dis_rot(0.0, glm::pi<float>() * 2.0f); // Full rotation range

    // Add a central light source (e.g., a "sun")
    scratchbox::Light sunLight;
    sunLight.type = scratchbox::LightType::DIRECTIONAL;
    sunLight.direction = glm::normalize(glm::vec3(-1.0f, -1.0f, -1.0f)); // From top-left-back
    sunLight.color = glm::vec3(1.0f, 0.9f, 0.8f); // Warm sun color
    sunLight.intensity = 5.0f;
    scene.addLight(sunLight);

    // Add ambient light for overall scene illumination
    scratchbox::Light ambientLight;
    ambientLight.type = scratchbox::LightType::AMBIENT;
    ambientLight.color = glm::vec3(0.1f, 0.1f, 0.15f); // Subtle blueish ambient
    ambientLight.intensity = 0.5f;
    scene.addLight(ambientLight);

    for (int i = 0; i < numberOfAsteroids; ++i) {
        Asteroid asteroid;
        asteroid.position = glm::vec3(dis_pos(gen), dis_pos(gen), dis_pos(gen));
        // Ensure asteroids are within a spherical fieldRadius
        if (glm::length(asteroid.position) > fieldRadius) {
            asteroid.position = glm::normalize(asteroid.position) * fieldRadius * dis_pos(gen) * 0.5f; // Push back into bounds
        }

        asteroid.rotation = glm::vec3(dis_rot(gen), dis_rot(gen), dis_rot(gen));
        asteroid.scale = glm::vec3(dis_scale(gen));

        // Generate a unique mesh for each asteroid to vary shapes slightly
        float baseRadius = 0.5f * asteroid.scale.x; // Base radius influenced by scale
        int subdivisions = 1; // Low subdivisions for basic shape
        float irregularity = 0.5f + (dis_pos(gen) / fieldRadius) * 0.5f; // Vary irregularity
        scratchbox::Mesh asteroidMesh = generateAsteroidMesh(baseRadius, subdivisions, irregularity);

        scratchbox::Model asteroidModel;
        asteroidModel.addMesh(asteroidMesh);
        asteroidModel.setPosition(asteroid.position);
        asteroidModel.setRotation(asteroid.rotation); // Assuming setRotation takes Euler angles or similar
        asteroidModel.setScale(asteroid.scale);

        // Basic material for asteroids
        scratchbox::Material asteroidMaterial;
        asteroidMaterial.diffuse = glm::vec3(0.4f, 0.3f, 0.2f); // Dull rock color
        asteroidMaterial.specular = glm::vec3(0.1f, 0.1f, 0.1f); // Low specularity
        asteroidMaterial.shininess = 10.0f;
        asteroidModel.setMaterial(asteroidMaterial);

        scene.addModel(asteroidModel);
    }

    std::cout << "Generated " << numberOfAsteroids << " asteroids." << std::endl;

    // Placeholder for orbital physics:
    // In a real-time simulation, this would be part of an update loop.
    // For a static scene generation, we might pre-calculate positions at a certain time.
    // For this initial scene, positions are randomly distributed.

    return scene;
}

// Example of how this might be exposed for FFI (e.g., Node-API for Electron)
extern "C" {
    // A simplified wrapper to return a serialized scene, or a pointer to it
    // Actual FFI would involve careful memory management and data serialization.
    // For now, let's assume scratchbox::SceneData can be easily serialized/deserialized
    // or directly passed if the engine is in the same process.
    // This is a placeholder for the actual FFI binding.
    const char* getAsteroidFieldSceneData(int numberOfAsteroids, float fieldRadius) {
        scratchbox::SceneData scene = generateAsteroidFieldScene(numberOfAsteroids, fieldRadius);
        // In a real scenario, 'scene' would be serialized to JSON/binary and returned,
        // or passed to a rendering engine directly.
        // For demonstration, we'll just return a success message.
        std::string result = "Scene generated with " + std::to_string(scene.getModels().size()) + " models.";
        char* c_str_result = new char[result.length() + 1];
        strcpy(c_str_result, result.c_str());
        return c_str_result;
    }
}