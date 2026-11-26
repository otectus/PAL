cmake_minimum_required(VERSION 3.24)
project(PAL VERSION 2.0.3 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Quick Qml Network Widgets DBus)
find_package(LayerShellQt REQUIRED)
set(PAL_NATIVE native/controller.cpp native/controller.h native/activitymodel.cpp native/activitymodel.h native/citations.h native/motion.cpp native/motion.h native/avatarcatalog.h)
add_library(pal-avatar-renderer STATIC native/avatarpuppet.cpp native/avatarpuppet.h native/avatarstartup.cpp)
target_include_directories(pal-avatar-renderer PUBLIC native)
target_link_libraries(pal-avatar-renderer PUBLIC Qt6::Quick)
qt_add_executable(pal-prepare-avatar-startup tools/prepare-avatar-startup.cpp)
target_link_libraries(pal-prepare-avatar-startup PRIVATE pal-avatar-renderer)

# Extract the neutral artwork and exact pointer silhouettes while building. The first
# desktop frame and the settings cards need neither a live puppet nor its animation atlas.
set(PAL_ART_DIR "${CMAKE_CURRENT_SOURCE_DIR}/assets")
set(PAL_STARTUP_ART_DIR "${CMAKE_CURRENT_BINARY_DIR}/avatar-startup")
file(MAKE_DIRECTORY "${PAL_STARTUP_ART_DIR}")
set_property(GLOBAL APPEND PROPERTY JOB_POOLS pal_art_decoders=2)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${PAL_ART_DIR}/avatars.json" "${PAL_ART_DIR}/motions.json")
file(READ "${PAL_ART_DIR}/avatars.json" PAL_AVATAR_MANIFEST)
file(READ "${PAL_ART_DIR}/motions.json" PAL_MOTIONS)
string(JSON PAL_BASE_RIG GET "${PAL_MOTIONS}" rig)
string(JSON PAL_AVATAR_COUNT LENGTH "${PAL_AVATAR_MANIFEST}")
math(EXPR PAL_AVATAR_LAST "${PAL_AVATAR_COUNT} - 1")
foreach(index RANGE 0 ${PAL_AVATAR_LAST})
  string(JSON id GET "${PAL_AVATAR_MANIFEST}" ${index} id)
  string(JSON rig GET "${PAL_AVATAR_MANIFEST}" ${index} rig)
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${PAL_ART_DIR}/${rig}")
  file(READ "${PAL_ART_DIR}/${rig}" rig_json)
  string(JSON atlas GET "${rig_json}" texture)
  set(still "${PAL_STARTUP_ART_DIR}/${id}.png")
  set(mask "${PAL_STARTUP_ART_DIR}/${id}-mask.png")
  add_custom_command(OUTPUT "${still}" "${mask}"
    COMMAND ${CMAKE_COMMAND} -E env QT_QPA_PLATFORM=offscreen $<TARGET_FILE:pal-prepare-avatar-startup>
      "${PAL_ART_DIR}/${PAL_BASE_RIG}" "${PAL_ART_DIR}/${rig}" "${still}" "${mask}"
    DEPENDS pal-prepare-avatar-startup "${PAL_ART_DIR}/${PAL_BASE_RIG}" "${PAL_ART_DIR}/${rig}" "${PAL_ART_DIR}/${atlas}"
    JOB_POOL pal_art_decoders
    VERBATIM)
  list(APPEND PAL_STARTUP_IMAGES "${still}" "${mask}")
endforeach()
add_library(pal-avatar-startup-art OBJECT)
qt_add_resources(pal-avatar-startup-art "avatar_startup" PREFIX "/pal/avatar-startup"
  BASE "${PAL_STARTUP_ART_DIR}" FILES ${PAL_STARTUP_IMAGES})
# Embed the same transparent face that Android uses for its launcher foreground.
set(PAL_MOBILE_DRAWABLES "${CMAKE_CURRENT_SOURCE_DIR}/mobile/android/app/src/main/res/drawable-nodpi")
qt_add_resources(pal-avatar-startup-art "pal_brand" PREFIX "/pal/brand"
  BASE "${PAL_MOBILE_DRAWABLES}" FILES "${PAL_MOBILE_DRAWABLES}/pal_face_icon.png")
target_link_libraries(pal-avatar-startup-art PRIVATE Qt6::Core)
qt_add_executable(pal native/main.cpp ${PAL_NATIVE})
qt_add_resources(pal pal-avatars PREFIX "/" FILES assets/avatars.json)
target_link_libraries(pal PRIVATE pal-avatar-renderer pal-avatar-startup-art Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml Qt6::Network Qt6::Widgets Qt6::DBus LayerShellQt::Interface)
target_compile_definitions(pal PRIVATE PAL_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}" PAL_VERSION="${PROJECT_VERSION}")
set_target_properties(pal PROPERTIES INSTALL_RPATH "$ORIGIN")
include(GNUInstallDirs)
find_program(NODE_EXECUTABLE node REQUIRED)
add_custom_target(pal-avatar-manifest ALL
  COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/check-avatar-catalog.ts
  COMMENT "Validating the avatar manifest and runtime assets"
  VERBATIM)
add_dependencies(pal pal-avatar-manifest)
set(PAL_ICON_SIZES 16 22 24 32 48 64 128 256 512)
set(PAL_ICON_OUTPUTS)
foreach(PAL_ICON_SIZE IN LISTS PAL_ICON_SIZES)
  list(APPEND PAL_ICON_OUTPUTS "${CMAKE_CURRENT_BINARY_DIR}/icons/hicolor/${PAL_ICON_SIZE}x${PAL_ICON_SIZE}/apps/pal.png")
endforeach()
add_custom_command(
  OUTPUT ${PAL_ICON_OUTPUTS}
  COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/prepare-icons.mjs
    ${CMAKE_CURRENT_SOURCE_DIR}/assets/pal-emblem.png ${CMAKE_CURRENT_BINARY_DIR}/icons/hicolor
  DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/assets/pal-emblem.png ${CMAKE_CURRENT_SOURCE_DIR}/tools/prepare-icons.mjs
  COMMENT "Preparing PAL application icons"
  VERBATIM)
add_custom_target(pal-icons ALL DEPENDS ${PAL_ICON_OUTPUTS})
# The build's identity (package version, source commit, dirty), reported by the broker in
# diagnostics and in the mobile welcome. Rewritten only when it changes.
add_custom_target(pal-build-info ALL
  COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/build-info.mjs ${CMAKE_CURRENT_BINARY_DIR}/build-info.json
  BYPRODUCTS ${CMAKE_CURRENT_BINARY_DIR}/build-info.json
  COMMENT "Recording the build identity"
  VERBATIM)
add_dependencies(pal pal-icons)
find_package(Python3 3.12 REQUIRED COMPONENTS Interpreter)
find_path(NODE_INCLUDE_DIR node_api.h PATH_SUFFIXES node REQUIRED)
add_library(pal-peercred MODULE native/peercred.cpp)
target_include_directories(pal-peercred PRIVATE ${NODE_INCLUDE_DIR})
set_target_properties(pal-peercred PROPERTIES PREFIX "" SUFFIX ".node" AUTOMOC OFF)
add_library(pal-telemetry MODULE native/telemetry.cpp)
add_executable(pal-report native/report.cpp)
set_target_properties(pal-report PROPERTIES AUTOMOC OFF)
# Document export (broker/documents/service.ts): prints PAL's own HTML as a PDF, offscreen and without network access.
qt_add_executable(pal-document native/document.cpp)
target_link_libraries(pal-document PRIVATE Qt6::Gui)
set_target_properties(pal-document PROPERTIES AUTOMOC OFF)
# Workbench file access: descriptor-relative, beneath-root operations (openat2) for the broker.
add_executable(pal-workspacefs native/workspacefs.cpp)
set_target_properties(pal-workspacefs PROPERTIES AUTOMOC OFF)
# PAL terminals (broker/terminal/service.ts): one PTY-backed shell per worker, with the vendored libvterm 0.3.3
# screen model (MIT, native/third_party/libvterm/PROVENANCE.md).
enable_language(C)
file(GLOB PAL_LIBVTERM_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/native/third_party/libvterm/src/*.c)
add_executable(pal-terminal native/terminal/pal-terminal.c ${PAL_LIBVTERM_SOURCES})
set_target_properties(pal-terminal PROPERTIES AUTOMOC OFF C_STANDARD 11)
target_include_directories(pal-terminal PRIVATE native/third_party/libvterm/include native/third_party/libvterm/src)
target_link_libraries(pal-terminal PRIVATE util)
target_include_directories(pal-telemetry PRIVATE ${NODE_INCLUDE_DIR})
set_target_properties(pal-telemetry PROPERTIES PREFIX "" SUFFIX ".node" AUTOMOC OFF)
execute_process(COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/stage-runtime.mjs ${CMAKE_CURRENT_BINARY_DIR}/runtime RESULT_VARIABLE PAL_RUNTIME_RESULT)
if(NOT PAL_RUNTIME_RESULT EQUAL 0)
  message(FATAL_ERROR "Could not stage PAL runtime dependencies; run npm ci first")
endif()
execute_process(COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/prepare-tts.py
  --output ${CMAKE_CURRENT_BINARY_DIR}/tts --arch ${CMAKE_SYSTEM_PROCESSOR}
  RESULT_VARIABLE PAL_TTS_RESULT)
if(NOT PAL_TTS_RESULT EQUAL 0)
  message(FATAL_ERROR "Could not stage offline Piper speech assets; see tools/prepare-tts.py")
endif()
include(CTest)
if(BUILD_TESTING)
  find_package(Qt6 REQUIRED COMPONENTS Test)
  enable_language(C)
  find_package(PkgConfig REQUIRED)
  # Optional offline artwork tooling; the desktop renderer does not use OpenCV.
  pkg_search_module(PAL_OPENCV QUIET opencv5 opencv4)
  if(PAL_OPENCV_FOUND)
    add_executable(pal-avatar-interpolate tools/interpolate-avatar-poses.cpp tools/avatar-registration.h)
    add_executable(pal-avatar-registration-check tests/avatar-registration.cpp tools/avatar-registration.h)
    foreach(target pal-avatar-interpolate pal-avatar-registration-check)
      target_include_directories(${target} PRIVATE ${PAL_OPENCV_INCLUDE_DIRS})
      target_link_directories(${target} PRIVATE ${PAL_OPENCV_LIBRARY_DIRS})
      target_link_libraries(${target} PRIVATE opencv_video opencv_imgcodecs opencv_imgproc opencv_core)
    endforeach()
    set_target_properties(pal-avatar-interpolate pal-avatar-registration-check PROPERTIES AUTOMOC OFF)
    add_test(NAME avatar-registration COMMAND pal-avatar-registration-check)
  endif()
  pkg_check_modules(WAYLAND_CLIENT REQUIRED IMPORTED_TARGET wayland-client)
  find_program(WAYLAND_SCANNER wayland-scanner REQUIRED)
  set(PAL_POINTER_PROTOCOL ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/wlr-virtual-pointer-unstable-v1.xml)
  add_custom_command(OUTPUT wlr-virtual-pointer-client.h wlr-virtual-pointer-protocol.c
    COMMAND ${WAYLAND_SCANNER} client-header ${PAL_POINTER_PROTOCOL} wlr-virtual-pointer-client.h
    COMMAND ${WAYLAND_SCANNER} private-code ${PAL_POINTER_PROTOCOL} wlr-virtual-pointer-protocol.c
    DEPENDS ${PAL_POINTER_PROTOCOL} VERBATIM)
  qt_add_executable(pal-ui-check tests/ui.cpp ${PAL_NATIVE})
  target_sources(pal-ui-check PRIVATE tests/acceptancepointer.h
    ${CMAKE_CURRENT_BINARY_DIR}/wlr-virtual-pointer-client.h ${CMAKE_CURRENT_BINARY_DIR}/wlr-virtual-pointer-protocol.c)
  target_include_directories(pal-ui-check PRIVATE ${CMAKE_CURRENT_BINARY_DIR})
  qt_add_resources(pal-ui-check pal-test-avatars PREFIX "/" FILES assets/avatars.json)
  target_link_libraries(pal-ui-check PRIVATE pal-avatar-renderer pal-avatar-startup-art Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml Qt6::Network Qt6::Widgets Qt6::DBus Qt6::Test LayerShellQt::Interface PkgConfig::WAYLAND_CLIENT)
  target_compile_definitions(pal-ui-check PRIVATE PAL_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
  # Startup cost of the interface controller (time and peak memory), for before/after comparisons.
  qt_add_executable(pal-measure-startup tools/measure-startup.cpp ${PAL_NATIVE})
  qt_add_resources(pal-measure-startup pal-measure-avatars PREFIX "/" FILES assets/avatars.json)
  target_include_directories(pal-measure-startup PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/native)
  target_link_libraries(pal-measure-startup PRIVATE pal-avatar-renderer pal-avatar-startup-art Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml Qt6::Network Qt6::Widgets Qt6::DBus LayerShellQt::Interface)
  # Documentation screenshots from a scripted demo profile; tools/screenshots/run.sh prepares and runs it.
  qt_add_executable(pal-screenshots tools/screenshots/capture.cpp ${PAL_NATIVE})
  qt_add_resources(pal-screenshots pal-screenshot-avatars PREFIX "/" FILES assets/avatars.json)
  target_link_libraries(pal-screenshots PRIVATE pal-avatar-renderer pal-avatar-startup-art Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml Qt6::Network Qt6::Widgets Qt6::DBus Qt6::Test LayerShellQt::Interface)
  target_compile_definitions(pal-screenshots PRIVATE PAL_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
  qt_add_executable(pal-motion-check tests/motion.cpp native/motion.cpp native/motion.h)
  target_link_libraries(pal-motion-check PRIVATE Qt6::Core Qt6::Gui Qt6::Test)
  # Checked standard-library preconditions (for example std::clamp's ordered bounds).
  target_compile_definitions(pal-motion-check PRIVATE PAL_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}" _GLIBCXX_ASSERTIONS)
  add_test(NAME motion COMMAND pal-motion-check)
  qt_add_executable(pal-avatar-check tests/avatarpuppet.cpp)
  target_include_directories(pal-avatar-check PRIVATE native)
  target_link_libraries(pal-avatar-check PRIVATE pal-avatar-renderer Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml)
  add_test(NAME avatar COMMAND pal-avatar-check ${CMAKE_CURRENT_SOURCE_DIR})
  # Inherit the caller's display platform (private Wayland for acceptance,
  # Xvfb in CI); offscreen OpenGL does not preserve this test's readback geometry.
  set_tests_properties(avatar PROPERTIES ENVIRONMENT "QT_QUICK_BACKEND=rhi;QSG_RHI_BACKEND=opengl")
  add_test(NAME avatar-software COMMAND pal-avatar-check ${CMAKE_CURRENT_SOURCE_DIR})
  set_tests_properties(avatar-software PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_QUICK_BACKEND=software;PAL_PUPPET_TEST_SOFTWARE=1")
  qt_add_executable(pal-avatar-catalog-check tests/avatarcatalog.cpp native/avatarcatalog.h)
  target_include_directories(pal-avatar-catalog-check PRIVATE native)
  target_link_libraries(pal-avatar-catalog-check PRIVATE Qt6::Core)
  add_test(NAME avatar-catalog COMMAND pal-avatar-catalog-check ${CMAKE_CURRENT_SOURCE_DIR})
  # QML component tests. The portrait tests read their fixtures through XMLHttpRequest.
  find_program(PAL_QMLTESTRUNNER qmltestrunner HINTS "${QT6_INSTALL_PREFIX}/${QT6_INSTALL_BINS}" REQUIRED)
  add_test(NAME qml COMMAND ${PAL_QMLTESTRUNNER} -input ${CMAKE_CURRENT_SOURCE_DIR}/tests/qml -import ${CMAKE_CURRENT_SOURCE_DIR}/qml)
  set_tests_properties(qml PROPERTIES ENVIRONMENT "QML_XHR_ALLOW_FILE_READ=1;QT_QPA_PLATFORM=offscreen;QT_QUICK_BACKEND=software")
endif()
install(TARGETS pal RUNTIME DESTINATION ${CMAKE_INSTALL_LIBDIR}/pal)
install(PROGRAMS tools/pal DESTINATION ${CMAKE_INSTALL_BINDIR})
install(DIRECTORY qml assets broker DESTINATION ${CMAKE_INSTALL_DATADIR}/pal
  PATTERN "__pycache__" EXCLUDE
  PATTERN "*.pyc" EXCLUDE
  PATTERN "pal-memory-emitter.py" EXCLUDE
  PATTERN "cere-memory-emitter.py" EXCLUDE
  PATTERN "pal-memory-editor.py" EXCLUDE
  PATTERN "*.kate-swp" EXCLUDE
  PATTERN "*.swp" EXCLUDE)
install(PROGRAMS broker/graph-memory/adapters/fish/pal-memory-emitter.py DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/broker/graph-memory/adapters/fish)
install(PROGRAMS broker/graph-memory/adapters/editor/pal-memory-editor.py DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/broker/graph-memory/adapters/editor)
install(PROGRAMS broker/graph-memory/adapters/fish/cere-memory-emitter.py DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/broker/graph-memory/adapters/fish)
install(DIRECTORY protocol DESTINATION ${CMAKE_INSTALL_DATADIR}/pal)
install(DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/tts DESTINATION ${CMAKE_INSTALL_DATADIR}/pal USE_SOURCE_PERMISSIONS)
install(FILES tools/setup-speech.ts tools/setup-kokoro.py DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/tools)
install(FILES tools/setup-litellm.py tools/litellm-lock.txt DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/tools)
install(FILES tools/setup-indextts.py DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/tools)
install(FILES packaging/indextts-manifest.json DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/packaging)
install(TARGETS pal-peercred LIBRARY DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/native)
install(TARGETS pal-telemetry LIBRARY DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/native)
install(TARGETS pal-document RUNTIME DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/native)
install(TARGETS pal-workspacefs RUNTIME DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/native)
install(TARGETS pal-terminal RUNTIME DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/native)
install(FILES native/third_party/libvterm/LICENSE DESTINATION ${CMAKE_INSTALL_DATADIR}/licenses/pal/libvterm)
install(DIRECTORY shell DESTINATION ${CMAKE_INSTALL_DATADIR}/pal)
install(TARGETS pal-report RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(PROGRAMS tools/pal-run tools/pal-telemetry-hooks DESTINATION ${CMAKE_INSTALL_BINDIR})
install(DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/runtime/node_modules DESTINATION ${CMAKE_INSTALL_DATADIR}/pal)
install(FILES package.json package-lock.json ${CMAKE_CURRENT_BINARY_DIR}/build-info.json DESTINATION ${CMAKE_INSTALL_DATADIR}/pal)
install(FILES packaging/pal.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
# Per-user Dolphin service menus must be executable to be authorized by KIO.
install(PROGRAMS packaging/pal-dolphin.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/kio/servicemenus)
foreach(PAL_ICON_SIZE IN LISTS PAL_ICON_SIZES)
  install(FILES ${CMAKE_CURRENT_BINARY_DIR}/icons/hicolor/${PAL_ICON_SIZE}x${PAL_ICON_SIZE}/apps/pal.png
    DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/${PAL_ICON_SIZE}x${PAL_ICON_SIZE}/apps)
endforeach()
install(FILES packaging/pal-broker.service DESTINATION ${CMAKE_INSTALL_LIBDIR}/systemd/user)
# Preserve upgraded launchers and already-enabled user units under their former
# names while making PAL the only installed implementation.
set(PAL_COMPAT_DIR "${CMAKE_CURRENT_BINARY_DIR}/upgrade-links")
file(MAKE_DIRECTORY "${PAL_COMPAT_DIR}")
file(CREATE_LINK pal "${PAL_COMPAT_DIR}/cere" SYMBOLIC)
file(CREATE_LINK pal-broker.service "${PAL_COMPAT_DIR}/cere-broker.service" SYMBOLIC)
install(PROGRAMS "${PAL_COMPAT_DIR}/cere" DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES "${PAL_COMPAT_DIR}/cere-broker.service" DESTINATION ${CMAKE_INSTALL_LIBDIR}/systemd/user)
install(FILES README.md VALIDATION.md CHANGELOG.md DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal)
install(FILES reference/PAL.png DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal/reference)
install(FILES docs/tts.md DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal/docs)
install(FILES docs/workspace-telemetry.md DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal/docs)
install(FILES docs/PROVIDERS.md docs/FEATURE-MATRIX.md docs/CONVERSATION-STATES.md docs/SERVICES-GATE.md docs/REVIEW-VALIDATION.md DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal/docs)
install(FILES packaging/tts-NOTICES.md DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal/packaging)
install(DIRECTORY docs/memory docs/mobile docs/providers DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal/docs)
install(DIRECTORY screenshots DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/pal)
install(FILES packaging/memory-compose.yml packaging/memory.env.example DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/packaging)
install(PROGRAMS tools/memory-dependencies.sh DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/tools)
install(FILES tools/check-memory-adapters.ts DESTINATION ${CMAKE_INSTALL_DATADIR}/pal/tools)
