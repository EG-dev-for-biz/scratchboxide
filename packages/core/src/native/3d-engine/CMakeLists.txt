cmake_minimum_required(VERSION 3.15...3.28)
project(scratchbox_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Discover Python 3 and nanobind
find_package(Python 3 COMPONENTS Interpreter Development.Module REQUIRED)

# Query nanobind cmake dir directly from the python interpreter
execute_process(
    COMMAND "${Python_EXECUTABLE}" -m nanobind --cmake_dir
    OUTPUT_VARIABLE NANOBIND_CMAKE_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE NB_RESULT
)

if (NB_RESULT EQUAL 0 AND EXISTS "${NANOBIND_CMAKE_DIR}")
    list(APPEND CMAKE_PREFIX_PATH "${NANOBIND_CMAKE_DIR}")
endif()

find_package(nanobind CONFIG REQUIRED)

# Pre-compiled C++20 invariant kernel dynamic library (libscratchbox_core)
add_library(scratchbox_core SHARED
    src/scratchbox_core.cpp
)

target_include_directories(scratchbox_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

if (MSVC)
    target_compile_options(scratchbox_core PRIVATE /O2)
else()
    target_compile_options(scratchbox_core PRIVATE -O3)
endif()

# Nanobind module linking to pre-compiled scratchbox_core kernel
nanobind_add_module(scratchbox_native
    bindings/python_bindings.cpp
)

target_include_directories(scratchbox_native PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

find_package(ZLIB REQUIRED)

target_link_libraries(scratchbox_native PRIVATE
    scratchbox_core
    ZLIB::ZLIB
)

if (MSVC)
    target_compile_options(scratchbox_native PRIVATE /O2)
else()
    target_compile_options(scratchbox_native PRIVATE -O3)
endif()
