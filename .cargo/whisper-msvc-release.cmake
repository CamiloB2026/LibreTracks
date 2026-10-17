# Included after every project() of whisper.cpp (CMAKE_PROJECT_INCLUDE in
# config.toml; whisper-rs-sys forwards CMAKE_* variables to CMake).
#
# With MSVC and the Visual Studio generator, the `cmake` crate overwrites
# CMAKE_<LANG>_FLAGS_RELEASE to pass /MT and strips every /O flag from it, so
# whisper.cpp was built with no optimisation at all: recognising a guide took
# 162 s instead of 20 s. Put the optimisation back. Other compilers keep
# CMake's own Release flags, which the crate leaves alone.
if(MSVC)
  foreach(lang C CXX)
    if(NOT CMAKE_${lang}_FLAGS_RELEASE MATCHES "/O2")
      set(CMAKE_${lang}_FLAGS_RELEASE "${CMAKE_${lang}_FLAGS_RELEASE} /O2 /Ob2 /DNDEBUG")
    endif()
  endforeach()
endif()
