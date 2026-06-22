import 'dart:async';
import 'dart:io';

import 'package:socket_io_client/socket_io_client.dart' as io;

import 'models.dart';

class SocketService {
  io.Socket? _socket;
  String? _baseUrl;
  String? _token;

  final StreamController<JsonMap> _messageController =
      StreamController<JsonMap>.broadcast();
  final StreamController<JsonMap> _historyController =
      StreamController<JsonMap>.broadcast();
  final StreamController<JsonMap> _notificationController =
      StreamController<JsonMap>.broadcast();
  final StreamController<JsonMap> _presenceController =
      StreamController<JsonMap>.broadcast();
  final StreamController<JsonMap> _huddleController =
      StreamController<JsonMap>.broadcast();
  final StreamController<JsonMap> _huddleParticipantController =
      StreamController<JsonMap>.broadcast();
  final StreamController<JsonMap> _huddleSignalController =
      StreamController<JsonMap>.broadcast();
  final StreamController<JsonMap> _huddleMediaController =
      StreamController<JsonMap>.broadcast();

  Stream<JsonMap> get messages => _messageController.stream;
  Stream<JsonMap> get history => _historyController.stream;
  Stream<JsonMap> get notifications => _notificationController.stream;
  Stream<JsonMap> get presence => _presenceController.stream;
  Stream<JsonMap> get huddles => _huddleController.stream;
  Stream<JsonMap> get huddleParticipants => _huddleParticipantController.stream;
  Stream<JsonMap> get huddleSignals => _huddleSignalController.stream;
  Stream<JsonMap> get huddleMedia => _huddleMediaController.stream;

  bool get connected => _socket?.connected ?? false;
  String? get baseUrl => _baseUrl;
  String? get authToken => _token;

  void connect({
    required String baseUrl,
    required String token,
  }) {
    disconnect();
    _baseUrl = baseUrl;
    _token = token;
    _socket = io.io(
      baseUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .disableAutoConnect()
          .setAuth({'token': token})
          .build(),
    );

    final socket = _socket!;
    socket.on('chat:message', (data) => _add(_messageController, data));
    socket.on('chat:messageEdited', (data) => _add(_messageController, data));
    socket.on('chat:messageDeleted', (data) => _add(_messageController, data));
    socket.on('chat:history', (data) => _add(_historyController, data));
    socket.on(
      'chat:unread-bump',
      (data) => _add(_notificationController, data),
    );
    socket.on('notification', (data) => _add(_notificationController, data));
    socket.on('presence:update', (data) => _add(_presenceController, data));
    socket.on(
      'huddle:started',
      (data) => _add(_huddleController, {'event': 'started', ..._map(data)}),
    );
    socket.on(
      'huddle:ended',
      (data) => _add(_huddleController, {'event': 'ended', ..._map(data)}),
    );
    socket.on(
      'huddle:declined',
      (data) => _add(_huddleController, {'event': 'declined', ..._map(data)}),
    );
    socket.on(
      'huddle:error',
      (data) => _add(_huddleController, {'event': 'error', ..._map(data)}),
    );
    socket.on(
      'huddle:user-joined',
      (data) => _add(
        _huddleParticipantController,
        {'event': 'joined', ..._map(data)},
      ),
    );
    socket.on(
      'huddle:user-left',
      (data) => _add(
        _huddleParticipantController,
        {'event': 'left', ..._map(data)},
      ),
    );
    socket.on(
      'huddle:participants',
      (data) => _add(
        _huddleParticipantController,
        {'event': 'participants', ..._map(data)},
      ),
    );
    socket.on(
      'huddle:signal',
      (data) => _add(_huddleSignalController, _map(data)),
    );
    socket.on(
      'huddle:mute',
      (data) => _add(_huddleMediaController, {'event': 'mute', ..._map(data)}),
    );
    socket.on(
      'huddle:unmute',
      (data) =>
          _add(_huddleMediaController, {'event': 'unmute', ..._map(data)}),
    );
    socket.on(
      'huddle:camera-off',
      (data) => _add(
        _huddleMediaController,
        {'event': 'camera-off', ..._map(data)},
      ),
    );
    socket.on(
      'huddle:camera-on',
      (data) => _add(
        _huddleMediaController,
        {'event': 'camera-on', ..._map(data)},
      ),
    );
    socket.connect();
    socket.onConnect((_) => socket.emit('huddle:sync'));
  }

  void joinChannel(String channelId) {
    _socket?.emit('chat:join', channelId);
    _socket?.emit('chat:open', channelId);
  }

  void leaveChannel(String channelId) {
    _socket?.emit('chat:leave', channelId);
  }

  void sendChatMessage({
    required String channelId,
    required String message,
    String? tempId,
    List<ChatAttachment> attachments = const [],
  }) {
    _socket?.emit('chat:message', {
      'channelId': channelId,
      'text': message,
      'tempId': tempId,
      'attachments':
          attachments.map((item) => item.toJson()).toList(growable: false),
    });
  }

  void markRead(String channelId) {
    _socket?.emit('chat:read', {
      'channelId': channelId,
      'at': DateTime.now().toIso8601String(),
    });
  }

  void startHuddle({
    required String channelId,
    required String huddleId,
    String provider = 'mesh',
    JsonMap? clientCapabilities,
  }) {
    _socket?.emit('huddle:start', {
      'channelId': channelId,
      'huddleId': huddleId,
      'provider': provider,
      'platform': _platformName,
      if (clientCapabilities != null) 'clientCapabilities': clientCapabilities,
    });
  }

  void joinHuddle({
    required String channelId,
    required String huddleId,
    String provider = 'mesh',
    JsonMap? clientCapabilities,
  }) {
    _socket?.emit('huddle:join', {
      'channelId': channelId,
      'huddleId': huddleId,
      'provider': provider,
      'platform': _platformName,
      if (clientCapabilities != null) 'clientCapabilities': clientCapabilities,
    });
  }

  void syncHuddles() {
    _socket?.emit('huddle:sync');
  }

  void leaveHuddle({
    required String channelId,
    required String huddleId,
  }) {
    _socket
        ?.emit('huddle:leave', {'channelId': channelId, 'huddleId': huddleId});
  }

  void endHuddle({
    required String channelId,
    required String huddleId,
  }) {
    _socket?.emit('huddle:end', {'channelId': channelId, 'huddleId': huddleId});
  }

  void declineHuddle({
    required String channelId,
    required String huddleId,
    String? initiatorUserId,
  }) {
    _socket?.emit('huddle:decline', {
      'channelId': channelId,
      'huddleId': huddleId,
      if (initiatorUserId != null) 'initiatorUserId': initiatorUserId,
    });
  }

  void sendHuddleSignal({
    required String channelId,
    required String huddleId,
    required String targetUserId,
    required JsonMap data,
  }) {
    _socket?.emit('huddle:signal', {
      'channelId': channelId,
      'huddleId': huddleId,
      'targetUserId': targetUserId,
      'data': data,
    });
  }

  void setHuddleMuted(String channelId, bool muted) {
    _socket?.emit(
      muted ? 'huddle:mute' : 'huddle:unmute',
      {'channelId': channelId},
    );
  }

  void setHuddleCamera(String channelId, bool cameraOn) {
    _socket?.emit(
      cameraOn ? 'huddle:camera-on' : 'huddle:camera-off',
      {'channelId': channelId},
    );
  }

  void disconnect() {
    _socket?.dispose();
    _socket = null;
    _baseUrl = null;
    _token = null;
  }

  void _add(StreamController<JsonMap> controller, Object? data) {
    if (data is Map) {
      controller.add(Map<String, dynamic>.from(data));
    } else {
      controller.add({'data': data});
    }
  }

  JsonMap _map(Object? data) {
    if (data is Map) return Map<String, dynamic>.from(data);
    return {'data': data};
  }

  String get _platformName {
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'mobile';
  }
}
