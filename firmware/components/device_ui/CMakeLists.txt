# index.html.gz is built from /device-ui (`npm run build:device-ui`) and committed, so the
# firmware builds without Node. If it's missing, embed a small placeholder page instead.
set(ui_gz "${CMAKE_CURRENT_LIST_DIR}/index.html.gz")
if(NOT EXISTS "${ui_gz}" AND NOT CMAKE_BUILD_EARLY_EXPANSION)
    set(placeholder_dir "${CMAKE_BINARY_DIR}/device_ui_placeholder")
    file(MAKE_DIRECTORY "${placeholder_dir}")
    file(WRITE "${placeholder_dir}/index.html"
         "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
         "<title>DoubleLamp</title><body style='font:16px system-ui;background:#111;color:#eee;padding:24px'>"
         "<h1>DoubleLamp</h1><p>The lamp UI wasn't built into this firmware. Run "
         "<code>npm run build:device-ui</code> and rebuild. The API is at <a href=/api/v1/info>/api/v1/info</a>.")
    file(ARCHIVE_CREATE OUTPUT "${placeholder_dir}/index.html.gz" PATHS "${placeholder_dir}/index.html"
         FORMAT raw COMPRESSION GZip)
    set(ui_gz "${placeholder_dir}/index.html.gz")
    message(WARNING "DoubleLamp: device-ui not built; embedding a placeholder page")
endif()

idf_component_register(SRCS "device_ui.cpp"
                       INCLUDE_DIRS "include"
                       EMBED_FILES "${ui_gz}")
