import 'package:flutter/widgets.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../../core/models.dart';
import 'huddle_media_state_v2.dart';

enum HuddleMediaProviderKind {
  mesh,
  livekit,
}

abstract class HuddleMediaProvider extends ChangeNotifier {
  HuddleMediaProviderKind get kind;

  RTCVideoRenderer get localRenderer;
  Map<String, RTCVideoRenderer> get remoteRenderers;
  Map<String, String> get remoteNames;
  List<String> get remoteUserIds;
  HuddleMediaStateV2 get mediaStateV2;
  HuddleMediaDiagnosticsV2 get diagnostics;

  String? get channelId;
  String? get huddleId;
  bool get joined;
  bool get muted;
  bool get cameraOn;
  bool get starting;
  String? get error;

  Future<void> initialize();

  Future<void> join({
    required String channelId,
    required String huddleId,
    List<JsonMap> participants = const [],
  });

  Future<void> leave({bool emitLeave = true});

  Future<void> disposeController();

  Widget? buildLocalVideoView({bool mirror = false}) => null;

  Widget? buildRemoteVideoView(String userId) => null;

  void setMuted(bool value);

  void setCameraOn(bool value);
}
