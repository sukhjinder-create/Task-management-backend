import '../../../config/app_config.dart';
import '../../../core/models.dart';
import '../../../core/socket_service.dart';
import 'huddle_ice_config_service.dart';
import 'huddle_media_provider.dart';
import 'huddle_media_state_v2.dart';
import 'livekit_huddle_media_provider.dart';

class HuddleMediaService {
  const HuddleMediaService._();

  static HuddleMediaProviderKind get selectedProvider =>
      AppConfig.huddleLiveKitMobileCanaryEnabled &&
              !AppConfig.huddleLiveKitMobileForceMesh
          ? HuddleMediaProviderKind.livekit
          : HuddleMediaProviderKind.mesh;

  static String get requestedProvider =>
      selectedProvider == HuddleMediaProviderKind.livekit
          ? huddleMediaProviderLiveKit
          : huddleMediaProviderMesh;

  static JsonMap get clientCapabilities =>
      selectedProvider == HuddleMediaProviderKind.livekit
          ? {
              'clientType': 'mobile',
              'platform': 'mobile',
              'supportedProviders': const [
                huddleMediaProviderMesh,
                huddleMediaProviderLiveKit,
              ],
              'providerVersions': const {
                huddleMediaProviderLiveKit:
                    AppConfig.huddleLiveKitMobileProviderVersion,
              },
            }
          : const {
              'clientType': 'mobile',
              'platform': 'mobile',
              'supportedProviders': [huddleMediaProviderMesh],
              'providerVersions': {
                huddleMediaProviderMesh: 'mobile-mesh-1',
              },
            };

  static HuddleMediaProvider createProvider({
    required SocketService socket,
    required String currentUserId,
    HuddleIceBaseUrlProvider? apiBaseUrlProvider,
  }) {
    // The wrapper inherits an explicit session provider lock at join time and
    // retains the existing mesh provider as the default/fallback path.
    return LiveKitHuddleMediaProvider(
      socket: socket,
      currentUserId: currentUserId,
      apiBaseUrlProvider: apiBaseUrlProvider,
    );
  }
}
