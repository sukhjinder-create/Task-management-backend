import '../../../config/app_config.dart';
import '../../../core/socket_service.dart';
import 'huddle_ice_config_service.dart';
import 'huddle_media_provider.dart';
import 'livekit_huddle_media_provider.dart';
import 'mesh_huddle_media_provider.dart';

class HuddleMediaService {
  const HuddleMediaService._();

  static HuddleMediaProviderKind get selectedProvider =>
      AppConfig.huddleLiveKitMobileCanaryEnabled &&
              !AppConfig.huddleLiveKitMobileForceMesh
          ? HuddleMediaProviderKind.livekit
          : HuddleMediaProviderKind.mesh;

  static HuddleMediaProvider createProvider({
    required SocketService socket,
    required String currentUserId,
    HuddleIceBaseUrlProvider? apiBaseUrlProvider,
  }) {
    if (selectedProvider == HuddleMediaProviderKind.livekit) {
      return LiveKitHuddleMediaProvider(
        socket: socket,
        currentUserId: currentUserId,
        apiBaseUrlProvider: apiBaseUrlProvider,
      );
    }
    return MeshHuddleMediaProvider(
      socket: socket,
      currentUserId: currentUserId,
      apiBaseUrlProvider: apiBaseUrlProvider,
    );
  }
}
