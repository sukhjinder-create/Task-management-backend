import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:record/record.dart';

import '../../../core/models.dart';

typedef MobileTranscriptionAuthTokenProvider = String? Function();
typedef MobileTranscriptionDiagnosticsCallback = void Function(JsonMap data);

class MobileLiveTranscriptionClient {
  MobileLiveTranscriptionClient({
    required this.baseUrl,
    required this.authTokenProvider,
    required this.sessionId,
    this.participantId,
    this.language = 'multi',
    http.Client? httpClient,
    MobileTranscriptionDiagnosticsCallback? onDiagnostics,
  })  : _httpClient = httpClient ?? http.Client(),
        _ownsHttpClient = httpClient == null,
        _onDiagnostics = onDiagnostics;

  static const int _sampleRate = 16000;
  static const int _channels = 1;
  static const int _keepAliveMs = 8000;

  final String baseUrl;
  final MobileTranscriptionAuthTokenProvider authTokenProvider;
  final String sessionId;
  final String? participantId;
  final String language;
  final http.Client _httpClient;
  final bool _ownsHttpClient;
  final MobileTranscriptionDiagnosticsCallback? _onDiagnostics;

  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<List<int>>? _audioSub;
  StreamSubscription<dynamic>? _socketSub;
  WebSocket? _socket;
  Timer? _keepAliveTimer;

  bool _stopped = false;
  bool _started = false;
  int _sequenceNumber = 0;
  int _utteranceIndex = 0;
  int _chunksSent = 0;
  int _providerMessages = 0;
  DateTime _streamStartedAt = DateTime.now();
  String? _transcriptionSessionId;
  String? _participantDeviceId;
  String? _activeSourceSegmentId;

  Future<void> start() async {
    if (_started) return;
    _started = true;
    _stopped = false;
    _emitDiagnostics({'status': 'granting'});

    final grant = await _requestGrant();
    if (_stopped) return;

    _transcriptionSessionId = _readString(grant, ['transcriptionSession', 'id']);
    _participantDeviceId = _readString(
      grant,
      ['transcriptionSession', 'participantDeviceId'],
    );
    final listenUrl = _readString(grant, ['listenUrl']);
    final accessToken = _readString(grant, ['accessToken']);
    if (listenUrl == null || listenUrl.isEmpty) {
      throw StateError('transcription_listen_url_missing');
    }

    _emitDiagnostics({
      'status': 'connecting',
      'provider': _readString(grant, ['provider']) ?? 'deepgram',
      'model': _readString(grant, ['model']),
      'language': _readString(grant, ['language']) ?? language,
      'transcriptionSessionId': _transcriptionSessionId,
    });

    _socket = accessToken == null || accessToken.isEmpty
        ? await WebSocket.connect(listenUrl)
        : await WebSocket.connect(
            listenUrl,
            protocols: <String>['bearer', accessToken],
          );
    if (_stopped) return;

    _socketSub = _socket!.listen(
      _handleSocketMessage,
      onError: (Object error) {
        _emitDiagnostics({
          'status': 'failed',
          'reason': 'transcription_websocket_error',
          'error': '$error',
        });
      },
      onDone: () {
        if (!_stopped) {
          _emitDiagnostics({
            'status': 'failed',
            'reason': 'transcription_websocket_closed',
          });
        }
      },
      cancelOnError: false,
    );

    _streamStartedAt = DateTime.now();
    _keepAliveTimer = Timer.periodic(
      const Duration(milliseconds: _keepAliveMs),
      (_) => _sendKeepAlive(),
    );

    if (!await _recorder.hasPermission()) {
      throw StateError('transcription_microphone_permission_denied');
    }
    final stream = await _recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: _sampleRate,
        numChannels: _channels,
        autoGain: true,
        echoCancel: true,
        noiseSuppress: true,
      ),
    );
    _audioSub = stream.listen(
      (chunk) {
        if (_stopped || chunk.isEmpty) return;
        final socket = _socket;
        if (socket == null || socket.readyState != WebSocket.open) return;
        socket.add(chunk);
        _chunksSent += 1;
      },
      onError: (Object error) {
        _emitDiagnostics({
          'status': 'failed',
          'reason': 'transcription_recorder_error',
          'error': '$error',
        });
      },
      cancelOnError: false,
    );
    _emitDiagnostics({
      'status': 'streaming',
      'websocketOpen': true,
      'recorderStarted': true,
    });
  }

  Future<void> stop() async {
    _stopped = true;
    _started = false;
    _keepAliveTimer?.cancel();
    _keepAliveTimer = null;
    await _audioSub?.cancel();
    _audioSub = null;
    await _socketSub?.cancel();
    _socketSub = null;
    try {
      if (_socket?.readyState == WebSocket.open) {
        _socket?.add(jsonEncode({'type': 'CloseStream'}));
      }
      await _socket?.close();
    } catch (_) {
      // Best-effort cleanup only.
    }
    _socket = null;
    try {
      await _recorder.stop();
    } catch (_) {
      // Recorder may already be stopped by the platform.
    }
    _emitDiagnostics({'status': 'stopped'});
  }

  Future<void> dispose() async {
    await stop();
    await _recorder.dispose();
    if (_ownsHttpClient) _httpClient.close();
  }

  Future<JsonMap> _requestGrant() async {
    final authToken = authTokenProvider();
    if (authToken == null || authToken.isEmpty) {
      throw StateError('transcription_auth_token_missing');
    }
    final response = await _httpClient.post(
      Uri.parse('$baseUrl/huddle/transcription/sessions/$sessionId/grant'),
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer $authToken',
        'Content-Type': 'application/json',
        'x-client-type': 'mobile',
        'x-client-platform': 'android',
      },
      body: jsonEncode({
        if (participantId != null) 'participantId': participantId,
        'provider': 'deepgram',
        'language': language,
        'audioEncoding': 'linear16',
        'sampleRate': _sampleRate,
        'channels': _channels,
      }),
    );
    final payload = _decodePayload(response.body);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return payload;
    }
    throw StateError(
      _readString(payload, ['reason']) ??
          _readString(payload, ['error', 'reason']) ??
          'transcription_grant_failed',
    );
  }

  Future<void> _postProviderEvent({
    required JsonMap payload,
    required String text,
    required String status,
    required String sourceSegmentId,
    required int sequenceNumber,
    required String providerReceivedAt,
  }) async {
    final authToken = authTokenProvider();
    if (authToken == null || authToken.isEmpty) return;
    final timing = _segmentTiming(payload);
    final body = {
      'transcriptionSessionId': _transcriptionSessionId,
      'participantId': participantId,
      'participantDeviceId': _participantDeviceId,
      'provider': 'deepgram',
      'providerEventId': '$sourceSegmentId:$sequenceNumber:$status',
      'sourceSegmentId': sourceSegmentId,
      'sequenceNumber': sequenceNumber,
      'status': status,
      'text': text,
      'confidence': _deepgramConfidence(payload),
      'language': _readString(payload, ['channel', 'detected_language']) ??
          language,
      'startedAt': timing.$1,
      'endedAt': timing.$2,
      'clientProviderReceivedAt': providerReceivedAt,
      'clientPostedAt': DateTime.now().toUtc().toIso8601String(),
      'providerPayload': payload,
    };
    final response = await _httpClient.post(
      Uri.parse('$baseUrl/huddle/transcription/sessions/$sessionId/events'),
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer $authToken',
        'Content-Type': 'application/json',
        'x-client-type': 'mobile',
        'x-client-platform': 'android',
      },
      body: jsonEncode(body),
    );
    if (response.statusCode >= 200 && response.statusCode < 300) {
      _emitDiagnostics({'status': 'streaming', 'backendEvents': sequenceNumber});
    } else {
      _emitDiagnostics({
        'status': 'degraded',
        'reason': 'transcription_event_post_failed',
        'statusCode': response.statusCode,
      });
    }
  }

  void _handleSocketMessage(dynamic message) {
    if (_stopped || message is! String) return;
    final decoded = _jsonMap(message);
    if (decoded == null || decoded['type'] != 'Results') return;
    final text = _deepgramTranscript(decoded);
    if (text.isEmpty) return;

    _providerMessages += 1;
    final providerReceivedAt = DateTime.now().toUtc().toIso8601String();
    final isFinal =
        decoded['is_final'] == true || decoded['speech_final'] == true;
    final status = isFinal ? 'final' : 'partial';
    final sourceSegmentId = _allocateSourceSegmentId(isFinal);
    final sequence = _sequenceNumber;
    _sequenceNumber += 1;
    unawaited(
      _postProviderEvent(
        payload: decoded,
        text: text,
        status: status,
        sourceSegmentId: sourceSegmentId,
        sequenceNumber: sequence,
        providerReceivedAt: providerReceivedAt,
      ).catchError((Object error) {
        _emitDiagnostics({
          'status': 'degraded',
          'reason': 'transcription_event_post_exception',
          'error': '$error',
        });
      }),
    );
    _emitDiagnostics({
      'status': 'streaming',
      'providerMessages': _providerMessages,
      'chunksSent': _chunksSent,
      'lastProviderMessageAt': providerReceivedAt,
    });
  }

  String _allocateSourceSegmentId(bool isFinal) {
    _activeSourceSegmentId ??=
        'deepgram:${_transcriptionSessionId ?? sessionId}:utterance:$_utteranceIndex';
    final source = _activeSourceSegmentId!;
    if (isFinal) {
      _utteranceIndex += 1;
      _activeSourceSegmentId = null;
    }
    return source;
  }

  void _sendKeepAlive() {
    final socket = _socket;
    if (socket == null || socket.readyState != WebSocket.open) return;
    socket.add(jsonEncode({'type': 'KeepAlive'}));
  }

  String _deepgramTranscript(JsonMap payload) {
    final alternatives = payload['channel'] is Map
        ? (payload['channel'] as Map)['alternatives']
        : null;
    if (alternatives is! List || alternatives.isEmpty) return '';
    final first = alternatives.first;
    if (first is! Map) return '';
    final transcript = first['transcript'];
    return transcript is String ? transcript.trim() : '';
  }

  double? _deepgramConfidence(JsonMap payload) {
    final alternatives = payload['channel'] is Map
        ? (payload['channel'] as Map)['alternatives']
        : null;
    if (alternatives is! List || alternatives.isEmpty) return null;
    final first = alternatives.first;
    if (first is! Map) return null;
    final confidence = NumberParser.parse(first['confidence']);
    if (confidence == null) return null;
    return confidence.clamp(0, 1).toDouble();
  }

  (String?, String?) _segmentTiming(JsonMap payload) {
    final startSeconds = NumberParser.parse(payload['start']);
    final durationSeconds = NumberParser.parse(payload['duration']);
    if (startSeconds == null) return (null, null);
    final startedAt =
        _streamStartedAt.add(Duration(milliseconds: (startSeconds * 1000).round()));
    final endedAt = durationSeconds == null
        ? null
        : startedAt.add(Duration(milliseconds: (durationSeconds * 1000).round()));
    return (
      startedAt.toUtc().toIso8601String(),
      endedAt?.toUtc().toIso8601String(),
    );
  }

  JsonMap _decodePayload(String body) {
    final decoded = jsonDecode(body);
    if (decoded is Map) return JsonMap.from(decoded);
    return {'data': decoded};
  }

  JsonMap? _jsonMap(String body) {
    try {
      final decoded = jsonDecode(body);
      return decoded is Map ? JsonMap.from(decoded) : null;
    } catch (_) {
      return null;
    }
  }

  String? _readString(Map<dynamic, dynamic> map, List<String> path) {
    dynamic current = map;
    for (final key in path) {
      if (current is! Map) return null;
      current = current[key];
    }
    return current is String && current.trim().isNotEmpty
        ? current.trim()
        : null;
  }

  void _emitDiagnostics(JsonMap patch) {
    _onDiagnostics?.call({
      ...patch,
      'chunksSent': _chunksSent,
      'providerMessages': _providerMessages,
      'sampleRate': _sampleRate,
      'channels': _channels,
      'source': 'android_live_transcription',
      'observedAt': DateTime.now().toUtc().toIso8601String(),
    });
  }
}

class NumberParser {
  static double? parse(Object? value) {
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value);
    return null;
  }
}
