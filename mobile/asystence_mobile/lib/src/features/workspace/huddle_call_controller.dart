import 'package:flutter/widgets.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../core/models.dart';
import '../../core/socket_service.dart';
import 'huddle_media/huddle_ice_config_service.dart';
import 'huddle_media/huddle_media_provider.dart';
import 'huddle_media/huddle_media_service.dart';
import 'huddle_media/huddle_media_state_v2.dart';

class HuddleCallController extends ChangeNotifier {
  HuddleCallController({
    required SocketService socket,
    required String currentUserId,
    HuddleIceBaseUrlProvider? apiBaseUrlProvider,
  }) : _provider = HuddleMediaService.createProvider(
          socket: socket,
          currentUserId: currentUserId,
          apiBaseUrlProvider: apiBaseUrlProvider,
        );

  final HuddleMediaProvider _provider;
  bool _providerListenerAttached = false;

  HuddleMediaProviderKind get providerKind => _provider.kind;

  RTCVideoRenderer get localRenderer => _provider.localRenderer;

  Map<String, RTCVideoRenderer> get remoteRenderers =>
      _provider.remoteRenderers;

  Map<String, String> get remoteNames => _provider.remoteNames;

  List<String> get remoteUserIds => _provider.remoteUserIds;

  String? get channelId => _provider.channelId;

  String? get huddleId => _provider.huddleId;

  bool get joined => _provider.joined;

  bool get muted => _provider.muted;

  bool get cameraOn => _provider.cameraOn;

  bool get starting => _provider.starting;

  String? get error => _provider.error;

  HuddleMediaStateV2 get mediaStateV2 => _provider.mediaStateV2;

  HuddleMediaDiagnosticsV2 get diagnostics => _provider.diagnostics;

  Future<void> initialize() async {
    _attachProviderListener();
    await _provider.initialize();
  }

  Future<void> join({
    required String channelId,
    required String huddleId,
    String? provider,
    List<JsonMap> participants = const [],
  }) {
    return _provider.join(
      channelId: channelId,
      huddleId: huddleId,
      provider: provider,
      participants: participants,
    );
  }

  Future<void> leave({bool emitLeave = true}) {
    return _provider.leave(emitLeave: emitLeave);
  }

  Future<void> disposeController() async {
    await _provider.disposeController();
    _detachProviderListener();
  }

  Widget? buildLocalVideoView({
    bool mirror = false,
    RTCVideoViewObjectFit fit = RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
  }) {
    return _provider.buildLocalVideoView(mirror: mirror, fit: fit);
  }

  Widget? buildRemoteVideoView(
    String userId, {
    RTCVideoViewObjectFit fit = RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
  }) {
    return _provider.buildRemoteVideoView(userId, fit: fit);
  }

  void setMuted(bool value) {
    _provider.setMuted(value);
  }

  void setCameraOn(bool value) {
    _provider.setCameraOn(value);
  }

  void _attachProviderListener() {
    if (_providerListenerAttached) return;
    _provider.addListener(_handleProviderChanged);
    _providerListenerAttached = true;
  }

  void _detachProviderListener() {
    if (!_providerListenerAttached) return;
    _provider.removeListener(_handleProviderChanged);
    _providerListenerAttached = false;
  }

  void _handleProviderChanged() {
    notifyListeners();
  }
}
