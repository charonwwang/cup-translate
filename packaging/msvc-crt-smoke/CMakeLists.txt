cmake_minimum_required(VERSION 3.14...3.28)
project(cup_crt_contract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
add_library(model_candidate STATIC model.cpp)
add_executable(crt_contract main.cpp)
# The reference represents CTranslate2, which always uses the static CRT.
set_property(TARGET crt_contract PROPERTY MSVC_RUNTIME_LIBRARY MultiThreaded)
target_link_libraries(crt_contract PRIVATE model_candidate)
