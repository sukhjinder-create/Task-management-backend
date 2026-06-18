import 'package:flutter_webrtc/flutter_webrtc.dart';

const int huddleMediaModelVersion = 2;
const String huddleMediaProviderMesh = 'mesh';
const String huddleMediaProviderLiveKit = 'livekit';

enum HuddleMediaConnectionState {
  idle,
  connecting,
  joined,
  leaving,
  failed,
}

enum HuddleMediaTrackKind {
  audio,
  camera,
  screen,
}

enum HuddleMediaPublicationState {
  unpublished,
  publishing,
  published,
  failed,
}

enum HuddleMediaSubscriptionState {
  unsubscribed,
  subscribing,
  subscribed,
  failed,
}

class HuddleMediaTrackV2 {
  const HuddleMediaTrackV2({
    required this.trackId,
    required this.participantId,
    required this.deviceId,
    required this.kind,
    required this.publicationState,
    required this.subscriptionState,
    this.userId,
    this.providerTrackId,
    this.mediaTrackId,
    this.streamId,
    this.enabled = true,
    this.muted = false,
    this.isLocal = false,
  });

  final String trackId;
  final String participantId;
  final String deviceId;
  final String? userId;
  final HuddleMediaTrackKind kind;
  final HuddleMediaPublicationState publicationState;
  final HuddleMediaSubscriptionState subscriptionState;
  final String? providerTrackId;
  final String? mediaTrackId;
  final String? streamId;
  final bool enabled;
  final bool muted;
  final bool isLocal;
}

class HuddleMediaDeviceV2 {
  const HuddleMediaDeviceV2({
    required this.deviceId,
    required this.participantId,
    required this.provider,
    required this.connectionState,
    this.userId,
    this.isLocal = false,
    this.trackIds = const [],
  });

  final String deviceId;
  final String participantId;
  final String? userId;
  final String provider;
  final bool isLocal;
  final HuddleMediaConnectionState connectionState;
  final List<String> trackIds;
}

class HuddleMediaParticipantV2 {
  const HuddleMediaParticipantV2({
    required this.participantId,
    this.userId,
    this.username = '',
    this.isLocal = false,
    this.deviceIds = const [],
    this.trackIds = const [],
  });

  final String participantId;
  final String? userId;
  final String username;
  final bool isLocal;
  final List<String> deviceIds;
  final List<String> trackIds;
}

class HuddleMediaDiagnosticsV2 {
  const HuddleMediaDiagnosticsV2({
    required this.provider,
    required this.observedAt,
    this.participantCount = 0,
    this.deviceCount = 0,
    this.trackCount = 0,
    this.screenShareActive = false,
    this.screenShareParticipantIds = const [],
    this.activeSpeakerParticipantIds = const [],
    this.networkQualityByParticipantId = const {},
    this.providerState,
    this.fallbackCount = 0,
    this.lastFallbackReason,
  });

  factory HuddleMediaDiagnosticsV2.empty({
    String provider = huddleMediaProviderMesh,
  }) {
    return HuddleMediaDiagnosticsV2(
      provider: provider,
      observedAt: DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }

  final String provider;
  final DateTime observedAt;
  final int participantCount;
  final int deviceCount;
  final int trackCount;
  final bool screenShareActive;
  final List<String> screenShareParticipantIds;
  final List<String> activeSpeakerParticipantIds;
  final Map<String, String> networkQualityByParticipantId;
  final String? providerState;
  final int fallbackCount;
  final String? lastFallbackReason;
}

class HuddleMediaStateV2 {
  const HuddleMediaStateV2({
    required this.provider,
    required this.connectionState,
    required this.participants,
    required this.devices,
    required this.tracks,
    required this.diagnostics,
    this.version = huddleMediaModelVersion,
  });

  factory HuddleMediaStateV2.empty({
    String provider = huddleMediaProviderMesh,
  }) {
    return HuddleMediaStateV2(
      provider: provider,
      connectionState: HuddleMediaConnectionState.idle,
      participants: const [],
      devices: const [],
      tracks: const [],
      diagnostics: HuddleMediaDiagnosticsV2.empty(provider: provider),
    );
  }

  final int version;
  final String provider;
  final HuddleMediaConnectionState connectionState;
  final List<HuddleMediaParticipantV2> participants;
  final List<HuddleMediaDeviceV2> devices;
  final List<HuddleMediaTrackV2> tracks;
  final HuddleMediaDiagnosticsV2 diagnostics;
}

HuddleMediaStateV2 buildMeshHuddleMediaStateV2({
  required String currentUserId,
  required bool joined,
  required bool starting,
  required bool muted,
  required MediaStream? localStream,
  required Map<String, RTCVideoRenderer> remoteRenderers,
  required Map<String, String> remoteNames,
  required List<String> remoteUserIds,
}) {
  final participants = <HuddleMediaParticipantV2>[];
  final devices = <HuddleMediaDeviceV2>[];
  final tracks = <HuddleMediaTrackV2>[];
  final connectionState = starting
      ? HuddleMediaConnectionState.connecting
      : joined
          ? HuddleMediaConnectionState.joined
          : HuddleMediaConnectionState.idle;

  final includeLocal = joined || starting || localStream != null;
  if (includeLocal) {
    final deviceId = 'mesh:$currentUserId:local';
    final trackIds = <String>[];
    _addStreamTracks(
      tracks: tracks,
      trackIds: trackIds,
      stream: localStream,
      participantId: currentUserId,
      deviceId: deviceId,
      userId: currentUserId,
      isLocal: true,
      muted: muted,
    );
    devices.add(
      HuddleMediaDeviceV2(
        deviceId: deviceId,
        participantId: currentUserId,
        userId: currentUserId,
        provider: huddleMediaProviderMesh,
        isLocal: true,
        connectionState: connectionState,
        trackIds: trackIds,
      ),
    );
    participants.add(
      HuddleMediaParticipantV2(
        participantId: currentUserId,
        userId: currentUserId,
        isLocal: true,
        deviceIds: [deviceId],
        trackIds: trackIds,
      ),
    );
  }

  for (final userId in remoteUserIds) {
    if (userId == currentUserId) continue;
    final deviceId = 'mesh:$userId:remote';
    final trackIds = <String>[];
    _addStreamTracks(
      tracks: tracks,
      trackIds: trackIds,
      stream: remoteRenderers[userId]?.srcObject,
      participantId: userId,
      deviceId: deviceId,
      userId: userId,
      isLocal: false,
      muted: false,
    );
    devices.add(
      HuddleMediaDeviceV2(
        deviceId: deviceId,
        participantId: userId,
        userId: userId,
        provider: huddleMediaProviderMesh,
        isLocal: false,
        connectionState: HuddleMediaConnectionState.joined,
        trackIds: trackIds,
      ),
    );
    participants.add(
      HuddleMediaParticipantV2(
        participantId: userId,
        userId: userId,
        username: remoteNames[userId] ?? '',
        isLocal: false,
        deviceIds: [deviceId],
        trackIds: trackIds,
      ),
    );
  }

  final diagnostics = HuddleMediaDiagnosticsV2(
    provider: huddleMediaProviderMesh,
    observedAt: DateTime.now().toUtc(),
    participantCount: participants.length,
    deviceCount: devices.length,
    trackCount: tracks.length,
    screenShareActive: false,
    screenShareParticipantIds: const [],
  );

  return HuddleMediaStateV2(
    provider: huddleMediaProviderMesh,
    connectionState: connectionState,
    participants: participants,
    devices: devices,
    tracks: tracks,
    diagnostics: diagnostics,
  );
}

void _addStreamTracks({
  required List<HuddleMediaTrackV2> tracks,
  required List<String> trackIds,
  required MediaStream? stream,
  required String participantId,
  required String deviceId,
  required String userId,
  required bool isLocal,
  required bool muted,
}) {
  if (stream == null) return;
  final mediaTracks = stream.getTracks();
  for (var index = 0; index < mediaTracks.length; index += 1) {
    final track = mediaTracks[index];
    final kind = track.kind == 'video'
        ? HuddleMediaTrackKind.camera
        : HuddleMediaTrackKind.audio;
    final trackId = '$deviceId:${kind.name}:${track.id}:$index';
    trackIds.add(trackId);
    tracks.add(
      HuddleMediaTrackV2(
        trackId: trackId,
        participantId: participantId,
        deviceId: deviceId,
        userId: userId,
        kind: kind,
        providerTrackId: track.id,
        mediaTrackId: track.id,
        streamId: stream.id,
        enabled: track.enabled,
        muted: muted || !track.enabled,
        isLocal: isLocal,
        publicationState: HuddleMediaPublicationState.published,
        subscriptionState: HuddleMediaSubscriptionState.subscribed,
      ),
    );
  }
}
