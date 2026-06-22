import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../../core/models.dart';
import '../../../core/socket_service.dart';
import 'huddle_ice_config_service.dart';
import 'huddle_media_provider.dart';
import 'huddle_media_state_v2.dart';

class MeshHuddleMediaProvider extends HuddleMediaProvider {
  MeshHuddleMediaProvider({
    required this.socket,
    required this.currentUserId,
    HuddleIceBaseUrlProvider? apiBaseUrlProvider,
    HuddleIceConfigService? iceConfigService,
  }) {
    _iceConfigService = iceConfigService ??
        HuddleIceConfigService(apiBaseUrlProvider: apiBaseUrlProvider);
    _ownsIceConfigService = iceConfigService == null;
  }

  @override
  HuddleMediaProviderKind get kind => HuddleMediaProviderKind.mesh;

  final SocketService socket;
  final String currentUserId;
  late final HuddleIceConfigService _iceConfigService;
  late final bool _ownsIceConfigService;
  @override
  final RTCVideoRenderer localRenderer = RTCVideoRenderer();
  @override
  final Map<String, RTCVideoRenderer> remoteRenderers = {};
  @override
  final Map<String, String> remoteNames = {};
  final Map<String, RTCPeerConnection> _peers = {};
  final Map<String, List<RTCIceCandidate>> _candidateQueues = {};
  final Map<String, bool> _makingOffer = {};
  final Map<String, MediaStream> _inboundStreams = {};
  final Map<String, Timer> _disconnectTimers = {};
  final List<StreamSubscription<JsonMap>> _subs = [];
  HuddleMediaStateV2 _mediaStateV2 = HuddleMediaStateV2.empty();

  MediaStream? _localStream;
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
  HuddleMediaStateV2 get mediaStateV2 => _mediaStateV2;
  @override
  HuddleMediaDiagnosticsV2 get diagnostics => _mediaStateV2.diagnostics;
  @override
  List<String> get remoteUserIds {
    final ids = <String>{
      ...remoteNames.keys,
      ...remoteRenderers.keys,
      ..._peers.keys,
    };
    ids.remove(currentUserId);
    return ids.toList(growable: false)..sort();
  }

  @override
  void notifyListeners() {
    _refreshMediaStateV2();
    super.notifyListeners();
  }

  @override
  Future<void> initialize() async {
    await localRenderer.initialize();
    unawaited(_iceConfigService.getRtcConfiguration());
    _subs.add(socket.huddleSignals.listen(_handleSignal));
    _subs.add(socket.huddleParticipants.listen(_handleParticipants));
    _subs.add(
      socket.huddles.listen(
        (event) {
          final eventHuddleId = readString(event, ['huddleId', 'huddle_id']);
          final action = readString(event, ['action']);
          final matchesCurrent =
              eventHuddleId == null || eventHuddleId == huddleId;
          if (!matchesCurrent) return;
          if (event['event'] == 'ended' ||
              event['event'] == 'declined' ||
              (event['event'] == 'error' &&
                  (action == 'huddle:start' || action == 'huddle:join'))) {
            leave(emitLeave: false);
          }
        },
      ),
    );
  }

  @override
  Future<void> join({
    required String channelId,
    required String huddleId,
    String? provider,
    List<JsonMap> participants = const [],
  }) async {
    if (joined && this.huddleId == huddleId) {
      socket.joinHuddle(
        channelId: channelId,
        huddleId: huddleId,
        provider: huddleMediaProviderMesh,
        clientCapabilities: _clientCapabilities,
      );
      return;
    }
    starting = true;
    error = null;
    notifyListeners();

    try {
      this.channelId = channelId;
      this.huddleId = huddleId;
      await _ensureLocalMedia();
      socket.joinHuddle(
        channelId: channelId,
        huddleId: huddleId,
        provider: huddleMediaProviderMesh,
        clientCapabilities: _clientCapabilities,
      );
      joined = true;
      starting = false;
      notifyListeners();

      for (final participant in participants) {
        final id = readString(participant, ['userId', 'user_id']);
        if (id == null || id == currentUserId) continue;
        remoteNames[id] =
            readString(participant, ['username', 'name']) ?? 'Teammate';
        await _makeOffer(id);
      }
    } catch (err) {
      error = '$err';
      starting = false;
      joined = false;
      notifyListeners();
    }
  }

  JsonMap get _clientCapabilities => const {
        'clientType': 'mobile',
        'platform': 'mobile',
        'supportedProviders': ['mesh'],
        'providerVersions': {'mesh': 'mobile-mesh-1'},
      };

  @override
  Future<void> leave({bool emitLeave = true}) async {
    final currentChannel = channelId;
    final currentHuddle = huddleId;
    if (emitLeave && currentChannel != null && currentHuddle != null) {
      socket.leaveHuddle(channelId: currentChannel, huddleId: currentHuddle);
    }
    for (final pc in _peers.values) {
      await pc.close();
    }
    _peers.clear();
    _candidateQueues.clear();
    _makingOffer.clear();
    for (final timer in _disconnectTimers.values) {
      timer.cancel();
    }
    _disconnectTimers.clear();
    for (final stream in _inboundStreams.values) {
      stream.getTracks().forEach((track) => track.stop());
    }
    _inboundStreams.clear();
    for (final renderer in remoteRenderers.values) {
      renderer.srcObject = null;
      await renderer.dispose();
    }
    remoteRenderers.clear();
    remoteNames.clear();
    _localStream?.getTracks().forEach((track) => track.stop());
    _localStream = null;
    localRenderer.srcObject = null;
    channelId = null;
    huddleId = null;
    joined = false;
    starting = false;
    muted = false;
    cameraOn = true;
    notifyListeners();
  }

  @override
  Future<void> disposeController() async {
    for (final sub in _subs) {
      await sub.cancel();
    }
    await leave(emitLeave: false);
    await localRenderer.dispose();
    if (_ownsIceConfigService) _iceConfigService.dispose();
  }

  @override
  void setMuted(bool value) {
    muted = value;
    for (final track
        in _localStream?.getAudioTracks() ?? const <MediaStreamTrack>[]) {
      track.enabled = !value;
    }
    final currentChannel = channelId;
    if (currentChannel != null) socket.setHuddleMuted(currentChannel, value);
    notifyListeners();
  }

  @override
  void setCameraOn(bool value) {
    cameraOn = value;
    for (final track
        in _localStream?.getVideoTracks() ?? const <MediaStreamTrack>[]) {
      track.enabled = value;
    }
    final currentChannel = channelId;
    if (currentChannel != null) socket.setHuddleCamera(currentChannel, value);
    notifyListeners();
  }

  Future<void> _handleParticipants(JsonMap event) async {
    final currentChannel = channelId;
    final currentHuddle = huddleId;
    if (!joined || currentChannel == null || currentHuddle == null) return;
    if (readString(event, ['channelId', 'channel_id']) != currentChannel) {
      return;
    }
    if (readString(event, ['huddleId', 'huddle_id']) != currentHuddle) return;

    if (event['event'] == 'participants' && event['participants'] is List) {
      for (final raw in (event['participants'] as List).whereType<Map>()) {
        final participant = JsonMap.from(raw);
        final id = readString(participant, ['userId', 'user_id']);
        if (id == null || id == currentUserId) continue;
        remoteNames[id] =
            readString(participant, ['username', 'name']) ?? 'Teammate';
      }
      notifyListeners();
      for (final raw in (event['participants'] as List).whereType<Map>()) {
        final participant = JsonMap.from(raw);
        final id = readString(participant, ['userId', 'user_id']);
        if (id == null || id == currentUserId) continue;
        await _makeOffer(id);
      }
      return;
    }

    final userId = readString(event, ['userId', 'user_id']);
    if (userId == null || userId == currentUserId) return;
    if (event['event'] == 'joined') {
      remoteNames[userId] =
          readString(event, ['username', 'name']) ?? 'Teammate';
      notifyListeners();
      await _makeOffer(userId);
    } else if (event['event'] == 'left') {
      await _removePeer(userId);
    }
  }

  Future<void> _handleSignal(JsonMap event) async {
    final currentChannel = channelId;
    final currentHuddle = huddleId;
    if (!joined || currentChannel == null || currentHuddle == null) return;
    if (readString(event, ['channelId', 'channel_id']) != currentChannel) {
      return;
    }
    if (readString(event, ['huddleId', 'huddle_id']) != currentHuddle) return;

    final fromUserId = readString(event, ['fromUserId', 'from_user_id']);
    if (fromUserId == null || fromUserId == currentUserId) return;
    final dataRaw = event['data'];
    if (dataRaw is! Map) return;
    final data = JsonMap.from(dataRaw);
    final type = readString(data, ['type']);
    final peerId = fromUserId;
    final isPolite = currentUserId.compareTo(peerId) > 0;

    if (type == 'offer') {
      await _ensureLocalMedia();
      final pc = await _peerFor(peerId);
      final offerCollision = (_makingOffer[peerId] == true) ||
          pc.signalingState != RTCSignalingState.RTCSignalingStateStable;
      if (!isPolite && offerCollision) return;
      if (offerCollision) {
        try {
          await pc.setLocalDescription(RTCSessionDescription('', 'rollback'));
        } catch (_) {}
      }
      remoteNames[peerId] =
          readString(data, ['fromUsername', 'username', 'name']) ??
              remoteNames[peerId] ??
              'Teammate';
      await pc.setRemoteDescription(
        RTCSessionDescription(readString(data, ['sdp']) ?? '', 'offer'),
      );
      await _flushCandidates(peerId, pc);
      final answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      _sendSignal(peerId, {
        'type': 'answer',
        'sdp': answer.sdp,
      });
    } else if (type == 'answer') {
      final pc = _peers[peerId];
      if (pc == null) return;
      if (pc.signalingState ==
          RTCSignalingState.RTCSignalingStateHaveLocalOffer) {
        await pc.setRemoteDescription(
          RTCSessionDescription(readString(data, ['sdp']) ?? '', 'answer'),
        );
        await _flushCandidates(peerId, pc);
      }
    } else if (type == 'candidate') {
      final candidate = _candidateFrom(data);
      if (candidate == null) return;
      final pc = await _peerFor(peerId);
      final remoteDescription = await pc.getRemoteDescription();
      if (remoteDescription == null) {
        (_candidateQueues[peerId] ??= []).add(candidate);
      } else {
        try {
          await pc.addCandidate(candidate);
        } catch (_) {}
      }
    }
  }

  Future<void> _makeOffer(String targetUserId) async {
    await _ensureLocalMedia();
    final pc = await _peerFor(targetUserId);
    if (pc.signalingState != RTCSignalingState.RTCSignalingStateStable) return;
    _makingOffer[targetUserId] = true;
    final offer = await pc.createOffer();
    try {
      await pc.setLocalDescription(offer);
      _sendSignal(targetUserId, {
        'type': 'offer',
        'sdp': offer.sdp,
      });
    } finally {
      _makingOffer[targetUserId] = false;
    }
  }

  Future<MediaStream> _ensureLocalMedia() async {
    final existing = _localStream;
    if (existing != null) return existing;
    final stream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': {
        'facingMode': 'user',
        'width': {'ideal': 960},
        'height': {'ideal': 540},
      },
    });
    _localStream = stream;
    localRenderer.srcObject = stream;
    return stream;
  }

  Future<RTCPeerConnection> _peerFor(String targetUserId) async {
    final existing = _peers[targetUserId];
    if (existing != null) {
      final state = existing.connectionState;
      if (state != RTCPeerConnectionState.RTCPeerConnectionStateDisconnected &&
          state != RTCPeerConnectionState.RTCPeerConnectionStateFailed &&
          state != RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        return existing;
      }
      await _removePeer(targetUserId);
    }

    final pc = await createPeerConnection(
      await _iceConfigService.getRtcConfiguration(),
    );
    _peers[targetUserId] = pc;

    final localStream = await _ensureLocalMedia();
    for (final track in localStream.getTracks()) {
      await pc.addTrack(track, localStream);
    }

    pc.onIceCandidate = (candidate) {
      if (candidate.candidate == null) return;
      _sendSignal(targetUserId, {
        'type': 'candidate',
        'candidate': candidate.candidate,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      });
    };
    pc.onTrack = (event) async {
      var renderer = remoteRenderers[targetUserId];
      if (renderer == null) {
        renderer = RTCVideoRenderer();
        await renderer.initialize();
        remoteRenderers[targetUserId] = renderer;
      }
      if (event.streams.isNotEmpty) {
        renderer.srcObject = event.streams.first;
      } else {
        final stream = _inboundStreams[targetUserId] ??
            await createLocalMediaStream('remote-$targetUserId');
        _inboundStreams[targetUserId] = stream;
        await stream.addTrack(event.track);
        renderer.srcObject = stream;
      }
      notifyListeners();
    };
    pc.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _disconnectTimers.remove(targetUserId)?.cancel();
        return;
      }
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _removePeer(targetUserId);
        return;
      }
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected ||
          state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _disconnectTimers[targetUserId] ??= Timer(
          const Duration(seconds: 20),
          () {
            final latest = _peers[targetUserId];
            final latestState = latest?.connectionState;
            if (latestState ==
                    RTCPeerConnectionState.RTCPeerConnectionStateConnected ||
                latestState ==
                    RTCPeerConnectionState.RTCPeerConnectionStateConnecting) {
              return;
            }
            _removePeer(targetUserId);
          },
        );
      }
    };
    return pc;
  }

  Future<void> _removePeer(String targetUserId) async {
    final pc = _peers.remove(targetUserId);
    await pc?.close();
    _disconnectTimers.remove(targetUserId)?.cancel();
    _candidateQueues.remove(targetUserId);
    _makingOffer.remove(targetUserId);
    final stream = _inboundStreams.remove(targetUserId);
    stream?.getTracks().forEach((track) => track.stop());
    final renderer = remoteRenderers.remove(targetUserId);
    renderer?.srcObject = null;
    await renderer?.dispose();
    remoteNames.remove(targetUserId);
    notifyListeners();
  }

  void _sendSignal(String targetUserId, JsonMap data) {
    final currentChannel = channelId;
    final currentHuddle = huddleId;
    if (currentChannel == null || currentHuddle == null) return;
    socket.sendHuddleSignal(
      channelId: currentChannel,
      huddleId: currentHuddle,
      targetUserId: targetUserId,
      data: data,
    );
  }

  RTCIceCandidate? _candidateFrom(JsonMap data) {
    final raw = data['candidate'];
    final source = raw is Map ? JsonMap.from(raw) : data;
    final candidate = raw is String ? raw : readString(source, ['candidate']);
    if (candidate == null || candidate.isEmpty) return null;
    return RTCIceCandidate(
      candidate,
      readString(source, ['sdpMid', 'id']),
      readInt(source, ['sdpMLineIndex', 'label']),
    );
  }

  Future<void> _flushCandidates(String peerId, RTCPeerConnection pc) async {
    final queued = _candidateQueues.remove(peerId) ?? const <RTCIceCandidate>[];
    for (final candidate in queued) {
      try {
        await pc.addCandidate(candidate);
      } catch (_) {}
    }
  }

  void _refreshMediaStateV2() {
    _mediaStateV2 = buildMeshHuddleMediaStateV2(
      currentUserId: currentUserId,
      joined: joined,
      starting: starting,
      muted: muted,
      localStream: _localStream,
      remoteRenderers: remoteRenderers,
      remoteNames: remoteNames,
      remoteUserIds: remoteUserIds,
    );
  }
}
