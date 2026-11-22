#include <node_api.h>
static napi_value Hello(napi_env env, napi_callback_info info) { napi_value s; napi_create_string_utf8(env, "hello", NAPI_AUTO_LENGTH, &s); return s; }
NAPI_MODULE_INIT() { napi_value fn; napi_create_function(env, "hello", NAPI_AUTO_LENGTH, Hello, NULL, &fn); return fn; }
