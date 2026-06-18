import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';
import 'session_store.dart';

class ApiClient {
  ApiClient({
    required this.defaultBaseUrl,
    required this.sessionStore,
    http.Client? httpClient,
  }) : _http = httpClient ?? http.Client();

  final String defaultBaseUrl;
  final SessionStore sessionStore;
  final http.Client _http;

  String? _baseUrlOverride;
  AuthSession? Function()? sessionProvider;
  Future<void> Function(AuthSession? session)? onSessionChanged;
  Future<AuthSession?>? _refreshInFlight;

  Future<String> get baseUrl async =>
      _baseUrlOverride ?? await sessionStore.loadApiBaseUrl() ?? defaultBaseUrl;

  String get currentBaseUrl => _baseUrlOverride ?? defaultBaseUrl;

  Future<void> setBaseUrl(String value) async {
    final trimmed = value.trim().replaceAll(RegExp(r'/+$'), '');
    _baseUrlOverride = trimmed;
    await sessionStore.saveApiBaseUrl(trimmed);
  }

  Future<dynamic> get(
    String path, {
    Map<String, dynamic>? query,
    bool auth = true,
  }) {
    return request('GET', path, query: query, auth: auth);
  }

  Future<dynamic> post(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool auth = true,
  }) {
    return request('POST', path, body: body, query: query, auth: auth);
  }

  Future<dynamic> put(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool auth = true,
  }) {
    return request('PUT', path, body: body, query: query, auth: auth);
  }

  Future<dynamic> patch(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool auth = true,
  }) {
    return request('PATCH', path, body: body, query: query, auth: auth);
  }

  Future<dynamic> delete(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool auth = true,
  }) {
    return request('DELETE', path, body: body, query: query, auth: auth);
  }

  Future<dynamic> request(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool auth = true,
    bool retryOnUnauthorized = true,
  }) async {
    final uri = await _uri(path, query);
    final headers = await _headers(auth: auth);
    final encodedBody = body == null ? null : jsonEncode(body);

    final response = await _send(method, uri, headers, encodedBody);

    if (response.statusCode == 401 &&
        auth &&
        retryOnUnauthorized &&
        path != '/auth/refresh') {
      final refreshed = await _refreshSession();
      if (refreshed != null) {
        final retryHeaders = await _headers(auth: true);
        final retryResponse =
            await _send(method, uri, retryHeaders, encodedBody);
        return _decodeOrThrow(retryResponse);
      }
    }

    return _decodeOrThrow(response);
  }

  Future<dynamic> multipart(
    String path, {
    required String fileField,
    required File file,
    Map<String, String> fields = const {},
  }) async {
    final uri = await _uri(path, null);
    final request = http.MultipartRequest('POST', uri);
    final session = sessionProvider?.call();
    if (session != null && session.token.isNotEmpty) {
      request.headers['Authorization'] = 'Bearer ${session.token}';
      final workspaceId = session.user.workspaceId;
      if (workspaceId != null && workspaceId.isNotEmpty) {
        request.headers['x-workspace-id'] = workspaceId;
      }
    }
    request.fields.addAll(fields);
    request.files.add(await http.MultipartFile.fromPath(fileField, file.path));

    final streamed = await request.send();
    final response = await http.Response.fromStream(streamed);
    return _decodeOrThrow(response);
  }

  Future<Uri> _uri(String path, Map<String, dynamic>? query) async {
    final cleanBase = (await baseUrl).replaceAll(RegExp(r'/+$'), '');
    final cleanPath = path.startsWith('/') ? path : '/$path';
    final uri = Uri.parse('$cleanBase$cleanPath');
    final queryParameters = <String, String>{};
    for (final entry in (query ?? {}).entries) {
      if (entry.value == null) continue;
      queryParameters[entry.key] = '${entry.value}';
    }
    return queryParameters.isEmpty
        ? uri
        : uri.replace(queryParameters: queryParameters);
  }

  Future<Map<String, String>> _headers({required bool auth}) async {
    final headers = <String, String>{
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (!auth) return headers;

    final session = sessionProvider?.call();
    if (session == null) return headers;

    if (session.token.isNotEmpty) {
      headers['Authorization'] = 'Bearer ${session.token}';
    }
    final workspaceId = session.user.workspaceId;
    if (workspaceId != null && workspaceId.isNotEmpty) {
      headers['x-workspace-id'] = workspaceId;
    }
    return headers;
  }

  Future<http.Response> _send(
    String method,
    Uri uri,
    Map<String, String> headers,
    String? body,
  ) {
    switch (method.toUpperCase()) {
      case 'GET':
        return _http
            .get(uri, headers: headers)
            .timeout(const Duration(seconds: 30));
      case 'POST':
        return _http
            .post(uri, headers: headers, body: body)
            .timeout(const Duration(seconds: 30));
      case 'PUT':
        return _http
            .put(uri, headers: headers, body: body)
            .timeout(const Duration(seconds: 30));
      case 'PATCH':
        return _http
            .patch(uri, headers: headers, body: body)
            .timeout(const Duration(seconds: 30));
      case 'DELETE':
        return _http
            .delete(uri, headers: headers, body: body)
            .timeout(const Duration(seconds: 30));
      default:
        throw ApiException('Unsupported HTTP method $method');
    }
  }

  dynamic _decodeOrThrow(http.Response response) {
    final body = response.body.trim();
    dynamic decoded;
    if (body.isNotEmpty) {
      try {
        decoded = jsonDecode(body);
      } catch (_) {
        decoded = body;
      }
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return decoded;
    }

    String message = 'Request failed';
    if (decoded is Map) {
      message = '${decoded['error'] ?? decoded['message'] ?? message}';
    } else if (decoded is String && decoded.isNotEmpty) {
      message = decoded;
    }
    throw ApiException(
      message,
      statusCode: response.statusCode,
      details: decoded,
    );
  }

  Future<AuthSession?> _refreshSession() {
    _refreshInFlight ??= _doRefresh().whenComplete(() {
      _refreshInFlight = null;
    });
    return _refreshInFlight!;
  }

  Future<AuthSession?> _doRefresh() async {
    final current = sessionProvider?.call();
    if (current == null || current.refreshToken.isEmpty) {
      await onSessionChanged?.call(null);
      return null;
    }

    try {
      final data = await request(
        'POST',
        '/auth/refresh',
        body: {'refreshToken': current.refreshToken},
        auth: false,
        retryOnUnauthorized: false,
      );
      if (data is! Map) throw ApiException('Invalid refresh response');
      final refreshed = AuthSession.fromJson(Map<String, dynamic>.from(data));
      await onSessionChanged?.call(refreshed);
      return refreshed;
    } catch (_) {
      await onSessionChanged?.call(null);
      return null;
    }
  }
}
