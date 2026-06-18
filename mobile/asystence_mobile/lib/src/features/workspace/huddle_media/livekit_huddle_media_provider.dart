import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:livekit_client/livekit_client.dart' as lk;

import '../../../config/app_config.dart';
import '../../../core/models.dart';
import '../../../core/socket_service.dart';
import 'huddle_ice_config_service.dart';
import 'huddle_media_provider.dart';
import 'huddle_media_state_v2.dart';
import 'mesh_huddle_media_provider.dart';

class LiveKitHuddleMediaProvider extends HuddleMediaProvider {
  LiveKitHuddleMediaProvider({
    required this.socket,
    required this.currentUserId,
    HuddleIceBaseUrlProvider? apiBaseUrlProvider,
    http.Client? httpClient,
  })  : _apiBaseUrlProvider = apiBaseUrlProvider,
        _httpClient = httpClient ?? http.Client(),
        _ownsHttpClient = httpClient == null,
        _meshFallback = MeshHuddleMediaProvider(
          socket: socket,
          currentUserId: currentUserId,
          apiBaseUrlProvider: apiBaseUrlProvider,
        );

  @override
  HuddleMediaProviderKind get kind => _usingMeshFallback
      ? HuddleMediaProviderKind.mesh
      : HuddleMediaProviderKind.livekit;

  final SocketService socket;
  final String currentUserId;
  final HuddleIceBaseUrlProvider? _apiBaseUrlProvider;
  final http.Client _httpClient;
  final bool _ownsHttpClient;
  final MeshHuddleMediaProvider _meshFallback;
  final List<StreamSubscription<JsonMap>> _subs = [];
  dynamic _room;
  HuddleMediaStateV2 _mediaStateV2 =
      HuddleMediaStateV2.empty(provider: huddleMediaProviderLiveKit);
  bool _usingMeshFallback = false;
  bool _providerLockEstablished = false;
  Timer? _roomNotifyTimer;
  int _fallbackCount = 0;
  String? _lastFallbackReason;

  @override
  final RTCVideoRenderer localRenderer = RTCVideoRenderer();
  @override
  final Map<String, RTCVideoRenderer> remoteRenderers = {};
  @override
  final Map<String, String> remoteNames = {};
  @override
  String? channelId;
  @override
  String? huddleId;
  @override
  bool joined = false;
  @override
  bool muted = false;
  @override
  bool cameraOn = true;
  @override
  bool starting = false;
  @override
  String? error;

  @override
  HuddleMediaStateV2 get mediaStateV2 =>
      _usingMeshFallback ? _meshFallbackMediaStateV2() : _mediaStateV2;

  @override
  HuddleMediaDiagnosticsV2 get diagnostics => mediaStateV2.diagnostics;

  @override
  List<String> get remoteUserIds {
    if (_usingMeshFallback) return _meshFallback.remoteUserIds;
    final ids = <String>{
      ...remoteNames.keys,
      ..._remoteParticipants()
          .map((participant) => _userIdForParticipant(participant))
          .whereType<String>(),
    };
    ids.remove(currentUserId);
    return ids.toList(growable: false)..sort();
  }

  @override
  void notifyListeners() {
    if (_usingMeshFallback) {
      super.notifyListeners();
      return;
    }
    _refreshMediaStateV2();
    super.notifyListeners();
  }

  @override
  Future<void> initialize() async {
    await localRenderer.initialize();
    await _meshFallback.initialize();
    _meshFallback.addListener(_notifyFromMeshFallback);
    _subs.add(
      socket.huddles.listen((event) {
        final eventHuddleId = readString(event, ['huddleId', 'huddle_id']);
        final action = readString(event, ['action']);
        final matchesCurrent =
            eventHuddleId == null || eventHuddleId == huddleId;
        if (!matchesCurrent || _usingMeshFallback) return;
        if (event['event'] == 'ended' ||
            event['event'] == 'declined' ||
            (event['event'] == 'error' &&
                (action == 'huddle:start' || action == 'huddle:join'))) {
          leave(emitLeave: false);
        }
      }),
    );
  }

  @override
  Future<void> join({
    required String channelId,
    required String huddleId,
    List<JsonMap> participants = const [],
  }) async {
    if (AppConfig.huddleLiveKitMobileForceMesh ||
        !AppConfig.huddleLiveKitMobileCanaryEnabled) {
      _usingMeshFallback = true;
      _lastFallbackReason = AppConfig.huddleLiveKitMobileForceMesh
          ? 'mobile_livekit_force_mesh'
          : 'mobile_livekit_canary_disabled';
      await _meshFallback.join(
        channelId: channelId,
        huddleId: huddleId,
        participants: participants,
      );
      notifyListeners();
      return;
    }

    if (joined && this.huddleId == huddleId) {
      socket.joinHuddle(channelId: channelId, huddleId: huddleId);
      return;
    }
    starting = true;
    joined = false;
    error = null;
    _providerLockEstablished = false;
    this.channelId = channelId;
    this.huddleId = huddleId;
    notifyListeners();

    try {
      final tokenPayload = await _requestLiveKitResource(
        path: '/huddle/media/livekit/token',
        channelId: channelId,
        huddleId: huddleId,
      );
      _providerLockEstablished = true;
      final liveKitUrl =
          _readNestedString(tokenPayload, const ['liveKit', 'url']);
      final token = _readNestedString(tokenPayload, const ['liveKit', 'token']);
      if (liveKitUrl == null || liveKitUrl.isEmpty) {
        throw const _LiveKitJoinFailure('room_readiness_missing_url');
      }
      if (token == null || token.isEmpty) {
        throw const _LiveKitJoinFailure('token_readiness_missing_token');
      }

      final room = lk.Room(
        roomOptions: lk.RoomOptions(
          adaptiveStream: true,
          dynacast: true,
          defaultCameraCaptureOptions: const lk.CameraCaptureOptions(
            params: lk.VideoParametersPresets.h540_43,
            maxFrameRate: 24,
          ),
          defaultVideoPublishOptions: const lk.VideoPublishOptions(
            videoEncoding: lk.VideoEncoding(
              maxBitrate: 750000,
              maxFramerate: 24,
            ),
            videoSimulcastLayers: [
              lk.VideoParametersPresets.h180_43,
              lk.VideoParametersPresets.h360_43,
            ],
          ),
        ),
      );
      _room = room;
      _attachRoomListener(room);
      await room.connect(liveKitUrl, token);
      await _setMicrophoneEnabled(true);
      await _setCameraEnabled(true);
      socket.joinHuddle(channelId: channelId, huddleId: huddleId);
      joined = true;
      starting = false;
      muted = false;
      cameraOn = true;
      _seedRemoteNames(participants);
      notifyListeners();
    } catch (err) {
      final reason = err is _LiveKitJoinFailure
          ? err.reason
          : 'mobile_livekit_join_failed';
      if (_providerLockEstablished ||
          (err is _LiveKitJoinFailure && err.providerLocked)) {
        await _failLockedLiveKitSession(reason, err);
      } else {
        await _fallbackToMesh(
          reason: reason,
          channelId: channelId,
          huddleId: huddleId,
          participants: participants,
          error: err,
        );
      }
    }
  }

  @override
  Future<void> leave({bool emitLeave = true}) async {
    if (_usingMeshFallback) {
      await _meshFallback.leave(emitLeave: emitLeave);
      _usingMeshFallback = false;
      _copyStateFromMeshFallback();
      notifyListeners();
      return;
    }

    final currentChannel = channelId;
    final currentHuddle = huddleId;
    if (emitLeave && currentChannel != null && currentHuddle != null) {
      socket.leaveHuddle(channelId: currentChannel, huddleId: currentHuddle);
    }
    await _cleanupLiveKit();
    channelId = null;
    huddleId = null;
    joined = false;
    starting = false;
    muted = false;
    cameraOn = true;
    remoteNames.clear();
    error = null;
    _providerLockEstablished = false;
    notifyListeners();
  }

  @override
  Future<void> disposeController() async {
    _roomNotifyTimer?.cancel();
    _roomNotifyTimer = null;
    for (final sub in _subs) {
      await sub.cancel();
    }
    await leave(emitLeave: false);
    _meshFallback.removeListener(_notifyFromMeshFallback);
    await _meshFallback.disposeController();
    await localRenderer.dispose();
    if (_ownsHttpClient) _httpClient.close();
  }

  @override
  Widget? buildLocalVideoView({bool mirror = false}) {
    if (_usingMeshFallback) return null;
    final track = _cameraTrackForParticipant(_localParticipant());
    if (track == null) return null;
    final view = lk.VideoTrackRenderer(
      track,
      fit: lk.VideoViewFit.contain,
    );
    if (!mirror) return view;
    return Transform(
      alignment: Alignment.center,
      transform: Matrix4.diagonal3Values(-1, 1, 1),
      child: view,
    );
  }

  @override
  Widget? buildRemoteVideoView(String userId) {
    if (_usingMeshFallback) return null;
    for (final participant in _remoteParticipants()) {
      if (_userIdForParticipant(participant) != userId) continue;
      final track = _cameraTrackForParticipant(participant);
      if (track != null) {
        return lk.VideoTrackRenderer(
          track,
          fit: lk.VideoViewFit.contain,
        );
      }
    }
    return null;
  }

  @override
  void setMuted(bool value) {
    if (_usingMeshFallback) {
      _meshFallback.setMuted(value);
      _copyStateFromMeshFallback();
      notifyListeners();
      return;
    }
    muted = value;
    final currentChannel = channelId;
    if (currentChannel != null) socket.setHuddleMuted(currentChannel, value);
    notifyListeners();
    unawaited(
      _setMicrophoneEnabled(!value).catchError((Object err) {
        _fallbackForActiveFailure(
          'mobile_livekit_microphone_publish_failed',
          err,
        );
      }),
    );
  }

  @override
  void setCameraOn(bool value) {
    if (_usingMeshFallback) {
      _meshFallback.setCameraOn(value);
      _copyStateFromMeshFallback();
      notifyListeners();
      return;
    }
    cameraOn = value;
    final currentChannel = channelId;
    if (currentChannel != null) socket.setHuddleCamera(currentChannel, value);
    notifyListeners();
    unawaited(
      _setCameraEnabled(value).catchError((Object err) {
        _fallbackForActiveFailure('mobile_livekit_camera_publish_failed', err);
      }),
    );
  }

  Future<JsonMap> _requestLiveKitResource({
    required String path,
    required String channelId,
    required String huddleId,
    String? providerRoomId,
  }) async {
    final baseUrl = await _resolvedApiBaseUrl();
    final authToken = socket.authToken;
    if (authToken == null || authToken.isEmpty) {
      throw const _LiveKitJoinFailure('mobile_livekit_auth_token_missing');
    }

    JsonMap? lastPayload;
    for (var attempt = 0; attempt < 3; attempt += 1) {
      final response = await _httpClient.post(
        Uri.parse('$baseUrl$path'),
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer $authToken',
          'Content-Type': 'application/json',
          'x-client-type': 'mobile',
          'x-client-platform': _platformName,
        },
        body: jsonEncode({
          'provider': 'livekit',
          'channelId': channelId,
          'huddleId': huddleId,
          'sessionId': huddleId,
          if (providerRoomId != null) 'providerRoomId': providerRoomId,
          'platform': _platformName,
          'clientCapabilities': _clientCapabilities,
        }),
      );
      final payload = _decodePayload(response.body);
      lastPayload = payload;
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return payload;
      }
      final reason = readString(payload, ['reason']) ??
          readString(payload, ['error', 'reason']) ??
          'mobile_livekit_endpoint_failed';
      final providerLocked =
          _readNestedBool(payload, const ['authorization', 'providerLocked']) ||
              _readNestedBool(
                payload,
                const ['diagnostics', 'authorization', 'providerLocked'],
              );
      if (!_shouldRetryLiveKitRequest(response.statusCode, reason) ||
          attempt == 2) {
        throw _LiveKitJoinFailure(
          reason,
          providerLocked: providerLocked,
        );
      }
      await Future<void>.delayed(Duration(milliseconds: 250 * (attempt + 1)));
    }
    throw _LiveKitJoinFailure(
      readString(lastPayload ?? const {}, ['reason']) ??
          'mobile_livekit_endpoint_failed',
    );
  }

  Future<String> _resolvedApiBaseUrl() async {
    final supplied =
        _apiBaseUrlProvider == null ? null : await _apiBaseUrlProvider();
    final raw = supplied ?? socket.baseUrl ?? AppConfig.apiBaseUrl;
    return raw.trim().replaceAll(RegExp(r'/+$'), '');
  }

  JsonMap _decodePayload(String body) {
    final decoded = jsonDecode(body);
    if (decoded is Map) return JsonMap.from(decoded);
    return {'data': decoded};
  }

  bool _shouldRetryLiveKitRequest(int statusCode, String reason) {
    if (statusCode == 409) {
      return reason == 'durable_session_not_found' ||
          reason == 'durable_session_required';
    }
    return statusCode == 502 || statusCode == 503 || statusCode == 504;
  }

  Future<void> _fallbackToMesh({
    required String reason,
    required String channelId,
    required String huddleId,
    required List<JsonMap> participants,
    Object? error,
  }) async {
    _fallbackCount += 1;
    _lastFallbackReason = reason;
    this.error = error == null ? reason : '$reason: $error';
    await _cleanupLiveKit();
    _usingMeshFallback = true;
    _providerLockEstablished = false;
    joined = false;
    starting = false;
    await _meshFallback.join(
      channelId: channelId,
      huddleId: huddleId,
      participants: participants,
    );
    _copyStateFromMeshFallback();
    notifyListeners();
  }

  Future<void> _fallbackForActiveFailure(String reason, Object error) async {
    final currentChannel = channelId;
    final currentHuddle = huddleId;
    if (currentChannel == null || currentHuddle == null || _usingMeshFallback) {
      return;
    }
    if (_providerLockEstablished) {
      await _failLockedLiveKitSession(reason, error);
      return;
    }
    await _fallbackToMesh(
      reason: reason,
      channelId: currentChannel,
      huddleId: currentHuddle,
      participants: const [],
      error: error,
    );
  }

  Future<void> _failLockedLiveKitSession(String reason, Object error) async {
    _lastFallbackReason = reason;
    this.error = '$reason: $error';
    await _cleanupLiveKit();
    joined = false;
    starting = false;
    _usingMeshFallback = false;
    notifyListeners();
  }

  Future<void> _cleanupLiveKit() async {
    final room = _room;
    _room = null;
    if (room == null) return;
    try {
      await room.disconnect();
    } catch (_) {}
    try {
      await room.dispose();
    } catch (_) {}
  }

  void _attachRoomListener(dynamic room) {
    try {
      room.addListener(_handleRoomChanged);
    } catch (_) {}
  }

  void _handleRoomChanged() {
    if (_roomNotifyTimer?.isActive == true) return;
    _roomNotifyTimer = Timer(const Duration(milliseconds: 200), () {
      _roomNotifyTimer = null;
      notifyListeners();
    });
  }

  Future<void> _setMicrophoneEnabled(bool enabled) async {
    final participant = _localParticipant();
    if (participant == null) {
      throw const _LiveKitJoinFailure('livekit_local_participant_missing');
    }
    await participant.setMicrophoneEnabled(enabled);
  }

  Future<void> _setCameraEnabled(bool enabled) async {
    final participant = _localParticipant();
    if (participant == null) {
      throw const _LiveKitJoinFailure('livekit_local_participant_missing');
    }
    await participant.setCameraEnabled(enabled);
  }

  dynamic _localParticipant() {
    try {
      return _room?.localParticipant;
    } catch (_) {
      return null;
    }
  }

  List<dynamic> _remoteParticipants() {
    try {
      final remote = _room?.remoteParticipants;
      if (remote is Map) return remote.values.toList(growable: false);
      if (remote is Iterable) return remote.toList(growable: false);
    } catch (_) {}
    return const [];
  }

  dynamic _cameraTrackForParticipant(dynamic participant) {
    if (participant == null) return null;
    for (final publication in _publicationsForParticipant(participant)) {
      final source = _stringValue(publication, 'source').toLowerCase();
      final kind = _stringValue(publication, 'kind').toLowerCase();
      if (source.contains('camera') || kind.contains('video')) {
        final track = _readProperty(publication, 'track');
        if (track != null) return track;
      }
    }
    return null;
  }

  List<dynamic> _publicationsForParticipant(dynamic participant) {
    final candidates = [
      _readProperty(participant, 'trackPublications'),
      _readProperty(participant, 'videoTrackPublications'),
      _readProperty(participant, 'audioTrackPublications'),
      _readProperty(participant, 'tracks'),
    ];
    final publications = <dynamic>[];
    for (final item in candidates) {
      if (item is Map) publications.addAll(item.values);
      if (item is Iterable) publications.addAll(item);
    }
    return publications;
  }

  void _seedRemoteNames(List<JsonMap> participants) {
    for (final participant in participants) {
      final userId = readString(participant, ['userId', 'user_id']);
      if (userId == null || userId == currentUserId) continue;
      remoteNames[userId] =
          readString(participant, ['username', 'name']) ?? 'Teammate';
    }
  }

  void _refreshMediaStateV2() {
    final participants = <HuddleMediaParticipantV2>[];
    final devices = <HuddleMediaDeviceV2>[];
    final tracks = <HuddleMediaTrackV2>[];
    final connectionState = starting
        ? HuddleMediaConnectionState.connecting
        : joined
            ? HuddleMediaConnectionState.joined
            : error == null
                ? HuddleMediaConnectionState.idle
                : HuddleMediaConnectionState.failed;
    final activeSpeakerIds = _activeSpeakerParticipantIds();
    final networkQuality = <String, String>{};

    final local = _localParticipant();
    if (local != null || joined || starting) {
      _addParticipantState(
        participants: participants,
        devices: devices,
        tracks: tracks,
        participant: local,
        fallbackParticipantId: currentUserId,
        fallbackUserId: currentUserId,
        isLocal: true,
        connectionState: connectionState,
        networkQuality: networkQuality,
      );
    }
    for (final participant in _remoteParticipants()) {
      final userId = _userIdForParticipant(participant);
      _addParticipantState(
        participants: participants,
        devices: devices,
        tracks: tracks,
        participant: participant,
        fallbackParticipantId: userId ?? _participantId(participant),
        fallbackUserId: userId,
        isLocal: false,
        connectionState: HuddleMediaConnectionState.joined,
        networkQuality: networkQuality,
      );
    }

    final screenShareParticipantIds = tracks
        .where((track) => track.kind == HuddleMediaTrackKind.screen)
        .map((track) => track.participantId)
        .toSet()
        .toList(growable: false);
    _mediaStateV2 = HuddleMediaStateV2(
      provider: huddleMediaProviderLiveKit,
      connectionState: connectionState,
      participants: participants,
      devices: devices,
      tracks: tracks,
      diagnostics: HuddleMediaDiagnosticsV2(
        provider: huddleMediaProviderLiveKit,
        observedAt: DateTime.now().toUtc(),
        participantCount: participants.length,
        deviceCount: devices.length,
        trackCount: tracks.length,
        screenShareActive: screenShareParticipantIds.isNotEmpty,
        screenShareParticipantIds: screenShareParticipantIds,
        activeSpeakerParticipantIds: activeSpeakerIds,
        networkQualityByParticipantId: networkQuality,
        providerState: connectionState.name,
        fallbackCount: _fallbackCount,
        lastFallbackReason: _lastFallbackReason,
      ),
    );
  }

  void _addParticipantState({
    required List<HuddleMediaParticipantV2> participants,
    required List<HuddleMediaDeviceV2> devices,
    required List<HuddleMediaTrackV2> tracks,
    required dynamic participant,
    required String? fallbackParticipantId,
    required String? fallbackUserId,
    required bool isLocal,
    required HuddleMediaConnectionState connectionState,
    required Map<String, String> networkQuality,
  }) {
    final participantId =
        _participantId(participant, fallback: fallbackParticipantId);
    final userId = _userIdForParticipant(participant) ?? fallbackUserId;
    final name =
        _displayNameForParticipant(participant, fallbackUserId: userId);
    final deviceId = _deviceIdForParticipant(
      participant,
      participantId: participantId,
      isLocal: isLocal,
    );
    final participantTrackIds = <String>[];
    final quality = _networkQualityForParticipant(participant);
    if (quality.isNotEmpty) networkQuality[participantId] = quality;

    final publications = _publicationsForParticipant(participant);
    for (var index = 0; index < publications.length; index += 1) {
      final publication = publications[index];
      final trackId =
          '$deviceId:${_trackKindForPublication(publication).name}:$index';
      participantTrackIds.add(trackId);
      tracks.add(
        HuddleMediaTrackV2(
          trackId: trackId,
          participantId: participantId,
          deviceId: deviceId,
          userId: userId,
          kind: _trackKindForPublication(publication),
          providerTrackId: _stringValue(publication, 'sid'),
          mediaTrackId:
              _stringValue(_readProperty(publication, 'track'), 'sid'),
          enabled: !_boolValue(publication, 'muted'),
          muted: isLocal &&
                  _trackKindForPublication(publication) ==
                      HuddleMediaTrackKind.audio
              ? muted
              : _boolValue(publication, 'muted'),
          isLocal: isLocal,
          publicationState: _readProperty(publication, 'track') == null
              ? HuddleMediaPublicationState.unpublished
              : HuddleMediaPublicationState.published,
          subscriptionState: isLocal ||
                  _boolValue(publication, 'subscribed', defaultValue: true)
              ? HuddleMediaSubscriptionState.subscribed
              : HuddleMediaSubscriptionState.unsubscribed,
        ),
      );
    }

    devices.add(
      HuddleMediaDeviceV2(
        deviceId: deviceId,
        participantId: participantId,
        userId: userId,
        provider: huddleMediaProviderLiveKit,
        isLocal: isLocal,
        connectionState: connectionState,
        trackIds: participantTrackIds,
      ),
    );
    participants.add(
      HuddleMediaParticipantV2(
        participantId: participantId,
        userId: userId,
        username: name.isEmpty ? remoteNames[userId] ?? 'Teammate' : name,
        isLocal: isLocal,
        deviceIds: [deviceId],
        trackIds: participantTrackIds,
      ),
    );
    if (!isLocal && userId != null) {
      remoteNames[userId] =
          name.isEmpty ? remoteNames[userId] ?? 'Teammate' : name;
    }
  }

  List<String> _activeSpeakerParticipantIds() {
    try {
      final speakers = _room?.activeSpeakers;
      if (speakers is Iterable) {
        return speakers
            .map((participant) => _participantId(participant))
            .where((id) => id.isNotEmpty)
            .toList(growable: false);
      }
    } catch (_) {}
    return const [];
  }

  String _participantId(dynamic participant, {String? fallback}) {
    final userId = _userIdForParticipant(participant);
    if (userId != null && userId.isNotEmpty) return userId;
    final identity = _stringValue(participant, 'identity');
    if (identity.isNotEmpty && !_isProviderIdentity(identity)) return identity;
    final sid = _stringValue(participant, 'sid');
    if (sid.isNotEmpty) return sid;
    return fallback ?? 'unknown';
  }

  String? _userIdForParticipant(dynamic participant) {
    final identity = _stringValue(participant, 'identity');
    final userId = _providerIdentitySegment(identity, 'user');
    if (userId != null) return userId;
    return identity.isEmpty || _isProviderIdentity(identity) ? null : identity;
  }

  String _deviceIdForParticipant(
    dynamic participant, {
    required String participantId,
    required bool isLocal,
  }) {
    final identity = _stringValue(participant, 'identity');
    return _providerIdentitySegment(identity, 'device') ??
        '$participantId:${isLocal ? 'local' : 'remote'}';
  }

  String _displayNameForParticipant(
    dynamic participant, {
    String? fallbackUserId,
  }) {
    final directName = _safeDisplayName(_stringValue(participant, 'name'));
    if (directName.isNotEmpty) return directName;

    final metadata = _metadataForParticipant(participant);
    for (final key in const ['displayName', 'username', 'name', 'userName']) {
      final name = _safeDisplayName(metadata[key]?.toString());
      if (name.isNotEmpty) return name;
    }

    if (fallbackUserId != null) {
      final cachedName = _safeDisplayName(remoteNames[fallbackUserId]);
      if (cachedName.isNotEmpty) return cachedName;
    }
    return '';
  }

  String _safeDisplayName(String? value) {
    final name = (value ?? '').trim();
    if (name.isEmpty || _isProviderIdentity(name)) return '';
    return name.length > 80 ? name.substring(0, 80) : name;
  }

  bool _isProviderIdentity(String value) {
    final identity = value.trim().toLowerCase();
    return identity.startsWith('livekit:') ||
        identity.contains(':workspace:') ||
        identity.contains(':huddle:');
  }

  String? _providerIdentitySegment(String identity, String segment) {
    final parts = identity.split(':');
    final index = parts.indexOf(segment);
    if (index < 0 || index + 1 >= parts.length) return null;
    final value = parts[index + 1].trim();
    return value.isEmpty ? null : value;
  }

  JsonMap _metadataForParticipant(dynamic participant) {
    final metadata = _readProperty(participant, 'metadata');
    if (metadata is Map) return Map<String, dynamic>.from(metadata);
    if (metadata is String && metadata.trim().isNotEmpty) {
      try {
        final parsed = jsonDecode(metadata);
        if (parsed is Map) return Map<String, dynamic>.from(parsed);
      } catch (_) {}
    }
    return {};
  }

  HuddleMediaTrackKind _trackKindForPublication(dynamic publication) {
    final source = _stringValue(publication, 'source').toLowerCase();
    final kind = _stringValue(publication, 'kind').toLowerCase();
    if (source.contains('screen')) return HuddleMediaTrackKind.screen;
    if (source.contains('camera') || kind.contains('video')) {
      return HuddleMediaTrackKind.camera;
    }
    return HuddleMediaTrackKind.audio;
  }

  String _networkQualityForParticipant(dynamic participant) {
    final quality = _stringValue(participant, 'connectionQuality');
    if (quality.isNotEmpty) return quality;
    return _stringValue(participant, 'networkQualityLevel');
  }

  dynamic _readProperty(dynamic source, String key) {
    if (source == null) return null;
    if (source is Map) return source[key];
    try {
      switch (key) {
        case 'audioTrackPublications':
          return source.audioTrackPublications;
        case 'connectionQuality':
          return source.connectionQuality;
        case 'identity':
          return source.identity;
        case 'kind':
          return source.kind;
        case 'muted':
          return source.muted;
        case 'metadata':
          return source.metadata;
        case 'name':
          return source.name;
        case 'networkQualityLevel':
          return source.networkQualityLevel;
        case 'sid':
          return source.sid;
        case 'source':
          return source.source;
        case 'subscribed':
          return source.subscribed;
        case 'track':
          return source.track;
        case 'trackPublications':
          return source.trackPublications;
        case 'tracks':
          return source.tracks;
        case 'videoTrackPublications':
          return source.videoTrackPublications;
      }
    } catch (_) {}
    return null;
  }

  String _stringValue(dynamic source, String key) {
    final value = _readProperty(source, key);
    return value == null ? '' : '$value';
  }

  bool _boolValue(
    dynamic source,
    String key, {
    bool defaultValue = false,
  }) {
    final value = _readProperty(source, key);
    if (value is bool) return value;
    if (value is String) return value.toLowerCase() == 'true';
    return defaultValue;
  }

  String? _readNestedString(JsonMap payload, List<String> path) {
    dynamic current = payload;
    for (final part in path) {
      if (current is! Map) return null;
      current = current[part];
    }
    return current == null ? null : '$current';
  }

  bool _readNestedBool(JsonMap payload, List<String> path) {
    dynamic current = payload;
    for (final part in path) {
      if (current is! Map) return false;
      current = current[part];
    }
    if (current is bool) return current;
    return '$current'.toLowerCase() == 'true';
  }

  JsonMap get _clientCapabilities => {
        'clientType': 'mobile',
        'platform': _platformName,
        'supportedProviders': const ['mesh', 'livekit'],
        'providerVersions': const {
          'livekit': AppConfig.huddleLiveKitMobileProviderVersion,
        },
      };

  String get _platformName {
    if (Platform.isIOS) return 'ios';
    if (Platform.isAndroid) return 'android';
    return 'mobile';
  }

  void _copyStateFromMeshFallback() {
    channelId = _meshFallback.channelId;
    huddleId = _meshFallback.huddleId;
    joined = _meshFallback.joined;
    muted = _meshFallback.muted;
    cameraOn = _meshFallback.cameraOn;
    starting = _meshFallback.starting;
    error = _meshFallback.error;
  }

  void _notifyFromMeshFallback() {
    _copyStateFromMeshFallback();
    super.notifyListeners();
  }

  HuddleMediaStateV2 _meshFallbackMediaStateV2() {
    final state = _meshFallback.mediaStateV2;
    final diagnostics = state.diagnostics;
    return HuddleMediaStateV2(
      version: state.version,
      provider: state.provider,
      connectionState: state.connectionState,
      participants: state.participants,
      devices: state.devices,
      tracks: state.tracks,
      diagnostics: HuddleMediaDiagnosticsV2(
        provider: diagnostics.provider,
        observedAt: diagnostics.observedAt,
        participantCount: diagnostics.participantCount,
        deviceCount: diagnostics.deviceCount,
        trackCount: diagnostics.trackCount,
        screenShareActive: diagnostics.screenShareActive,
        screenShareParticipantIds: diagnostics.screenShareParticipantIds,
        activeSpeakerParticipantIds: diagnostics.activeSpeakerParticipantIds,
        networkQualityByParticipantId:
            diagnostics.networkQualityByParticipantId,
        providerState: diagnostics.providerState ?? 'fallback_mesh',
        fallbackCount: _fallbackCount,
        lastFallbackReason: _lastFallbackReason,
      ),
    );
  }
}

class _LiveKitJoinFailure implements Exception {
  const _LiveKitJoinFailure(
    this.reason, {
    this.providerLocked = false,
  });

  final String reason;
  final bool providerLocked;

  @override
  String toString() => reason;
}
