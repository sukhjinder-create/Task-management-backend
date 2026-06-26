import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../core/models.dart';
import '../../core/socket_service.dart';
import 'huddle_media/huddle_ice_config_service.dart';
import 'huddle_media/huddle_media_provider.dart';
import 'huddle_media/huddle_media_service.dart';
import 'huddle_media/huddle_media_state_v2.dart';

/// One entry in the live caption feed. Mirrors the shape pushed by the
/// backend's huddle:caption socket event (services/huddleTranscriptionPipeline
/// .service.js -> routes/huddleTranscription.routes.js), which is the same
/// canonical pipeline every platform (web, Android, mobile browser) posts
/// Deepgram results through.
class HuddleCaption {
  HuddleCaption({
    required this.id,
    required this.text,
    required this.status,
    this.speakerLabel,
    this.emittedAt,
  });

  factory HuddleCaption.fromJson(JsonMap json) {
    final speaker = json['speaker'];
    return HuddleCaption(
      id: readString(json, ['id']) ?? '',
      text: readString(json, ['text']) ?? '',
      status: readString(json, ['status']) ?? 'partial',
      speakerLabel: speaker is Map
          ? readString(JsonMap.from(speaker), ['label'])
          : null,
      emittedAt: readString(json, ['emittedAt', 'emitted_at']),
    );
  }

  final String id;
  final String text;
  final String status;
  final String? speakerLabel;
  final String? emittedAt;
}

class HuddleCallController extends ChangeNotifier {
  HuddleCallController({
    required SocketService socket,
    required String currentUserId,
    HuddleIceBaseUrlProvider? apiBaseUrlProvider,
  })  : _socket = socket,
        _provider = HuddleMediaService.createProvider(
          socket: socket,
          currentUserId: currentUserId,
          apiBaseUrlProvider: apiBaseUrlProvider,
        );

  final SocketService _socket;
  final HuddleMediaProvider _provider;
  bool _providerListenerAttached = false;
  StreamSubscription<JsonMap>? _captionSub;
  final List<HuddleCaption> _captions = [];

  static const int _maxCaptionHistory = 50;

  List<HuddleCaption> get captions => List.unmodifiable(_captions);

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
    _attachCaptionListener();
    await _provider.initialize();
  }

  Future<void> join({
    required String channelId,
    required String huddleId,
    String? provider,
    List<JsonMap> participants = const [],
  }) {
    _captions.clear();
    return _provider.join(
      channelId: channelId,
      huddleId: huddleId,
      provider: provider,
      participants: participants,
    );
  }

  Future<void> leave({bool emitLeave = true}) {
    _captions.clear();
    return _provider.leave(emitLeave: emitLeave);
  }

  void _attachCaptionListener() {
    _captionSub ??= _socket.huddleCaptions.listen((payload) {
      // A device is only ever connected to one huddle call at a time (the
      // call UI is only shown while joined), so unlike the web client this
      // doesn't need to match the event's sessionId against a locally
      // tracked one — anything arriving while joined belongs to this call.
      if (!joined) return;
      final captionJson = payload['caption'];
      if (captionJson is! Map) return;
      final caption = HuddleCaption.fromJson(JsonMap.from(captionJson));
      if (caption.id.isEmpty || caption.text.isEmpty) return;
      _captions.removeWhere((existing) => existing.id == caption.id);
      _captions.add(caption);
      if (_captions.length > _maxCaptionHistory) {
        _captions.removeRange(0, _captions.length - _maxCaptionHistory);
      }
      notifyListeners();
    });
  }

  Future<void> disposeController() async {
    await _captionSub?.cancel();
    _captionSub = null;
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
