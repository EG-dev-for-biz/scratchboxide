
#include "scratchbox_engine.hpp"
#include <vector>
#include <string>

// Function to generate a highway overpass
extern "C" scratchbox::Scene3DData generate_scene() {
    scratchbox::Scene3DData scene;
    scene.title = "Civil Highway Overpass";
    scene.subtitle = "Procedural C++ generated 3D scene";
    scene.worldBranch = "civil/highway-overpass";
    scene.renderMode = "pbr";
    scene.cameraMode = "orbit";
    scene.animation = "idle";
    scene.camera.position = {50, 40, 70};
    scene.camera.target = {0, 10, 0};
    scene.camera.fov = 45;
    scene.environment.skybox = "industrial_sunset";
    scene.environment.lighting = "golden_hour";
    scene.environment.ground = true;

    // Ground plane
    scratchbox::Mesh ground_plane;
    ground_plane.id = "ground_plane";
    ground_plane.name = "Ground Plane";
    ground_plane.type = "box";
    ground_plane.position = {0, -0.5, 0};
    ground_plane.scale = {200, 1, 200};
    ground_plane.material.color = "#4CAF50"; // Dark green for ground
    ground_plane.material.metalness = 0.0;
    ground_plane.material.roughness = 0.9;
    scene.customMeshes.push_back(ground_plane);

    // Main highway road (bottom)
    scratchbox::Mesh main_road;
    main_road.id = "main_road";
    main_road.name = "Main Road";
    main_road.type = "box";
    main_road.position = {0, 0, 0};
    main_road.scale = {100, 0.5, 20};
    main_road.material.color = "#333333"; // Asphalt color
    main_road.material.metalness = 0.05;
    main_road.material.roughness = 0.8;
    scene.customMeshes.push_back(main_road);

    // Overpass road
    scratchbox::Mesh overpass_road;
    overpass_road.id = "overpass_road";
    overpass_road.name = "Overpass Road";
    overpass_road.type = "box";
    overpass_road.position = {0, 10, 0};
    overpass_road.scale = {80, 0.5, 15};
    overpass_road.material.color = "#444444"; // Slightly different asphalt
    overpass_road.material.metalness = 0.05;
    overpass_road.material.roughness = 0.75;
    scene.customMeshes.push_back(overpass_road);

    // Overpass support columns
    for (int i = -2; i <= 2; ++i) {
        if (i == 0) continue; // Skip middle to allow road underneath
        scratchbox::Mesh column;
        column.id = "column_" + std::to_string(i);
        column.name = "Support Column " + std::to_string(i);
        column.type = "cylinder";
        column.position = {static_cast<double>(i * 20), 5, 0};
        column.scale = {3, 10, 3};
        column.material.color = "#9E9E9E"; // Concrete color
        column.material.metalness = 0.1;
        column.material.roughness = 0.6;
        scene.customMeshes.push_back(column);
    }

    // Guard rails for overpass
    for (int side = -1; side <= 1; side += 2) { // Left and right side
        scratchbox::Mesh rail_left;
        rail_left.id = "rail_left_" + std::to_string(side);
        rail_left.name = "Guard Rail Left " + std::to_string(side);
        rail_left.type = "box";
        rail_left.position = {0, 10.75, static_cast<double>(side * 8)};
        rail_left.scale = {80, 0.5, 0.5};
        rail_left.material.color = "#CCCCCC"; // Light grey metal
        rail_left.material.metalness = 0.9;
        rail_left.material.roughness = 0.3;
        scene.customMeshes.push_back(rail_left);

        scratchbox::Mesh rail_right;
        rail_right.id = "rail_right_" + std::to_string(side);
        rail_right.name = "Guard Rail Right " + std::to_string(side);
        rail_right.type = "box";
        rail_right.position = {0, 10.75, static_cast<double>(side * 8)};
        rail_right.scale = {80, 0.5, 0.5};
        rail_right.material.color = "#CCCCCC"; // Light grey metal
        rail_right.material.metalness = 0.9;
        rail_right.material.roughness = 0.3;
        scene.customMeshes.push_back(rail_right);
    }

    // Add some simple cars on the roads
    // On main road
    for (int i = -3; i <= 3; ++i) {
        if (i % 2 == 0) {
            scratchbox::Mesh car;
            car.id = "car_main_" + std::to_string(i);
            car.name = "Car Main " + std::to_string(i);
            car.type = "box";
            car.position = {static_cast<double>(i * 15), 0.75, 5};
            car.scale = {4, 1.5, 2};
            car.material.color = "#FF0000"; // Red car
            car.material.metalness = 0.7;
            car.material.roughness = 0.2;
            scene.customMeshes.push_back(car);
        } else {
            scratchbox::Mesh car;
            car.id = "car_main_" + std::to_string(i);
            car.name = "Car Main " + std::to_string(i);
            car.type = "box";
            car.position = {static_cast<double>(i * 10), 0.75, -5};
            car.scale = {4, 1.5, 2};
            car.material.color = "#0000FF"; // Blue car
            car.material.metalness = 0.7;
            car.material.roughness = 0.2;
            scene.customMeshes.push_back(car);
        }
    }

    // On overpass road
    for (int i = -2; i <= 2; ++i) {
        if (i % 2 == 0) {
            scratchbox::Mesh car;
            car.id = "car_overpass_" + std::to_string(i);
            car.name = "Car Overpass " + std::to_string(i);
            car.type = "box";
            car.position = {static_cast<double>(i * 12), 11.25, 3};
            car.scale = {4, 1.5, 2};
            car.material.color = "#00FF00"; // Green car
            car.material.metalness = 0.7;
            car.material.roughness = 0.2;
            scene.customMeshes.push_back(car);
        } else {
            scratchbox::Mesh car;
            car.id = "car_overpass_" + std::to_string(i);
            car.name = "Car Overpass " + std::to_string(i);
            car.type = "box";
            car.position = {static_cast<double>(i * 8), 11.25, -3};
            car.scale = {4, 1.5, 2};
            car.material.color = "#FFFF00"; // Yellow car
            car.material.metalness = 0.7;
            car.material.roughness = 0.2;
            scene.customMeshes.push_back(car);
        }
    }

    return scene;
}
