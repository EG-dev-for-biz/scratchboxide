cmake_minimum_required(VERSION 3.10)
project(asteroid_generator CXX)

# Find scratchbox_engine.hpp
# In a real project, this would involve finding the SDK path.
# For now, we assume it's either in system includes or a known path.
# If it's in a specific directory, you'd add:
# include_directories(/path/to/scratchbox/sdk/include)

add_library(asteroid_generator SHARED asteroid_field_generator.cpp)

# Link any necessary libraries (e.g., if scratchbox_engine requires OpenGL, etc.)
# target_link_libraries(asteroid_generator PRIVATE scratchbox_engine_lib)
