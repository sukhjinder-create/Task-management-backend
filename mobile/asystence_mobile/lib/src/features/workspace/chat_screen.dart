import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/formatters.dart';
import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';
import 'huddle_call_controller.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    this.initialChannelKey,
    this.initialHuddleId,
    this.onImmersiveChanged,
  });

  final String? initialChannelKey;
  final String? initialHuddleId;
  final ValueChanged<bool>? onImmersiveChanged;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late Future<List<ChatChannel>> _channelsFuture;
  late Future<List<JsonMap>> _usersFuture;
  bool _ready = false;
  ChatChannel? _selected;
  List<ChatMessage> _messages = const [];
  Map<String, JsonMap> _usersById = const {};
  bool _loadingMessages = false;
  bool _sending = false;
  bool _uploadingAttachment = false;
  StreamSubscription<JsonMap>? _socketSub;
  StreamSubscription<JsonMap>? _historySub;
  StreamSubscription<JsonMap>? _notificationSub;
  StreamSubscription<JsonMap>? _huddleSub;
  StreamSubscription<JsonMap>? _huddleParticipantSub;
  final Map<String, JsonMap> _activeHuddles = {};
  final Map<String, List<JsonMap>> _huddleParticipants = {};
  Map<String, int> _unreadByChannel = const {};
  String? _pendingInitialChannelKey;
  String? _pendingInitialHuddleId;
  final Set<String> _joinedHuddles = {};
  final Set<String> _locallyStartedHuddles = {};
  final List<ChatAttachment> _pendingAttachments = [];
  final _message = TextEditingController();
  HuddleCallController? _call;
  bool _mobileHuddleControlsVisible = false;
  bool _immersiveReported = false;
  String? _huddleActionMessage;
  final ValueNotifier<int> _huddleUiVersion = ValueNotifier<int>(0);

  @override
  void initState() {
    super.initState();
    _pendingInitialChannelKey = widget.initialChannelKey;
    _pendingInitialHuddleId = widget.initialHuddleId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final appScope = AppScope.of(context);
      final socket = appScope.socket;
      final userId = appScope.auth.user?.id;
      if (userId != null) {
        final call = HuddleCallController(
          socket: socket,
          currentUserId: userId,
          apiBaseUrlProvider: () => appScope.client.baseUrl,
        );
        _call = call;
        call.addListener(_handleCallChanged);
        unawaited(call.initialize());
      }
      _socketSub = socket.messages.listen((event) {
        final msg = ChatMessage.fromJson(event);
        if (_selected != null && msg.channelId == _selected!.openKey) {
          _upsertMessage(msg);
          unawaited(_markSelectedRead());
        } else if (msg.channelId != null && msg.senderId != userId) {
          _bumpUnread(msg.channelId!);
        }
      });
      _historySub = socket.history.listen((event) {
        final channelId = readString(event, ['channelId', 'channel_id']);
        if (_selected == null || channelId != _selected!.openKey) return;
        final rawMessages = event['messages'];
        if (rawMessages is! List) return;
        final messages = rawMessages
            .whereType<Map>()
            .map(
              (item) => ChatMessage.fromJson(Map<String, dynamic>.from(item)),
            )
            .toList(growable: false);
        setState(() => _messages = _sortedUnique(messages));
      });
      _huddleSub = socket.huddles.listen(_handleHuddleEvent);
      _huddleParticipantSub =
          socket.huddleParticipants.listen(_handleHuddleParticipantEvent);
      _notificationSub = socket.notifications.listen(_handleSocketNotification);
      unawaited(_loadUnreadCounts());
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _channelsFuture = AppScope.of(context).api.channels();
      _usersFuture = AppScope.of(context).api.users();
      _ready = true;
    }
  }

  @override
  void dispose() {
    _setImmersive(false);
    _socketSub?.cancel();
    _historySub?.cancel();
    _notificationSub?.cancel();
    _huddleSub?.cancel();
    _huddleParticipantSub?.cancel();
    final call = _call;
    _call = null;
    if (call != null) {
      call.removeListener(_handleCallChanged);
      unawaited(call.disposeController());
    }
    _huddleUiVersion.dispose();
    _message.dispose();
    super.dispose();
  }

  void _setImmersive(bool value) {
    if (_immersiveReported == value) return;
    _immersiveReported = value;
    widget.onImmersiveChanged?.call(value);
  }

  void _bumpHuddleUi() {
    if (!mounted) return;
    _huddleUiVersion.value += 1;
  }

  void _setHuddleAction(String? message) {
    if (_huddleActionMessage == message) return;
    _huddleActionMessage = message;
    if (mounted) setState(() {});
    _bumpHuddleUi();
  }

  void _handleCallChanged() {
    if (!mounted) return;
    setState(() {});
    _bumpHuddleUi();
  }

  Future<void> _refreshChannels() async {
    setState(() {
      _channelsFuture = AppScope.of(context).api.channels();
      _usersFuture = AppScope.of(context).api.users();
    });
    await Future.wait([_channelsFuture, _usersFuture, _loadUnreadCounts()]);
  }

  Future<void> _openChannel(ChatChannel channel) async {
    setState(() {
      _selected = channel;
      _messages = const [];
      _pendingAttachments.clear();
      _message.clear();
      _loadingMessages = true;
    });
    _setImmersive(true);
    final channelKey = channel.openKey;
    AppScope.of(context).socket.joinChannel(channelKey);
    try {
      final messages =
          await AppScope.of(context).api.channelMessages(channelKey);
      if (!mounted || _selected?.openKey != channelKey) return;
      setState(() => _messages = _sortedUnique(messages));
      await _markSelectedRead();
    } on ApiException catch (err) {
      if (!mounted || _selected?.openKey != channelKey) return;
      if (channel.isDm && err.statusCode == 404) {
        setState(() => _messages = const []);
      } else {
        showSnack(context, err.message);
      }
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    } finally {
      if (mounted && _selected?.openKey == channelKey) {
        setState(() => _loadingMessages = false);
        await _openInitialHuddleIfNeeded(channelKey);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_selected != null) return _channelView(context);

    return RefreshIndicator(
      onRefresh: _refreshChannels,
      child: FutureBuilder<List<Object>>(
        future: Future.wait([_usersFuture, _channelsFuture]),
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            final err = snapshot.error;
            return EmptyState(
              icon: Icons.error_outline,
              title: 'Could not load chat',
              message: err is ApiException ? err.message : '$err',
            );
          }
          final users = (snapshot.data?[0] as List<JsonMap>?) ?? const [];
          final channels =
              (snapshot.data?[1] as List<ChatChannel>?) ?? const [];
          _usersById = {
            for (final user in users)
              if (readString(user, ['id', 'user_id']) != null)
                readString(user, ['id', 'user_id'])!: user,
          };
          final me = AppScope.of(context).auth.user;
          final teammates = users
              .where((user) => '${user['id']}' != me?.id)
              .toList(growable: false);
          _openInitialChannelWhenReady(teammates, channels);

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _sectionTitle(context, 'People'),
              if (teammates.isEmpty)
                const EmptyState(
                  icon: Icons.group_outlined,
                  title: 'No teammates found',
                  message:
                      'Workspace users will appear here for direct messages.',
                )
              else
                for (final user in teammates) ...[
                  _userTile(user),
                  const SizedBox(height: 8),
                ],
              const SizedBox(height: 14),
              _channelSectionHeader(context),
              if (channels.isEmpty)
                const EmptyState(
                  icon: Icons.forum_outlined,
                  title: 'No channels',
                  message:
                      'Shared channels appear here when team chat is enabled.',
                )
              else
                for (final channel in channels) ...[
                  _channelTile(channel),
                  const SizedBox(height: 8),
                ],
            ],
          );
        },
      ),
    );
  }

  Widget _sectionTitle(BuildContext context, String title) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(
        title,
        style: Theme.of(context).textTheme.labelLarge?.copyWith(
              color: scheme.primary,
              fontWeight: FontWeight.w800,
            ),
      ),
    );
  }

  Widget _channelSectionHeader(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Channels',
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                    color: scheme.primary,
                    fontWeight: FontWeight.w800,
                  ),
            ),
          ),
          IconButton.filledTonal(
            tooltip: 'Create channel',
            onPressed: _showCreateChannelSheet,
            icon: const Icon(Icons.add),
          ),
        ],
      ),
    );
  }

  Widget _userTile(JsonMap user) {
    final scheme = Theme.of(context).colorScheme;
    final me = AppScope.of(context).auth.user;
    final otherId = '${user['id'] ?? ''}';
    final ids = [me?.id ?? '', otherId]..sort();
    final key = 'dm:${ids[0]}:${ids[1]}';
    final name = readString(user, ['username', 'name', 'email']) ?? 'Teammate';
    final unread = _unreadByChannel[key] ?? 0;
    return ListTile(
      tileColor: scheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      leading: _Avatar(
        name: name,
        url: readString(user, ['avatarUrl', 'avatar_url', 'picture']),
      ),
      title: Text(name),
      subtitle: Text(readString(user, ['email', 'role']) ?? 'Direct message'),
      trailing: _UnreadBadge(count: unread),
      onTap: () =>
          _openChannel(ChatChannel(id: key, key: key, name: name, type: 'dm')),
    );
  }

  Widget _channelTile(ChatChannel channel) {
    final scheme = Theme.of(context).colorScheme;
    final unread = _unreadByChannel[channel.openKey] ?? 0;
    return ListTile(
      tileColor: scheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      leading: CircleAvatar(
        backgroundColor: scheme.surfaceContainerHighest,
        foregroundColor:
            channel.isReadOnly ? scheme.onSurfaceVariant : scheme.primary,
        child: Icon(channel.isReadOnly ? Icons.campaign_outlined : Icons.tag),
      ),
      title: Text(channel.name),
      subtitle: Text(
        channel.isReadOnly ? 'Read-only updates' : (channel.type ?? 'channel'),
      ),
      trailing: _UnreadBadge(count: unread),
      onTap: () => _openChannel(channel),
    );
  }

  Widget _channelView(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final currentUserId = AppScope.of(context).auth.user?.id;
    final channelKey = _selected!.openKey;
    final activeHuddle = _activeHuddles[channelKey];
    final displayMessages = _messages.reversed.toList(growable: false);

    return Column(
      children: [
        Material(
          elevation: 0,
          color: Theme.of(context).colorScheme.surface,
          child: SafeArea(
            bottom: false,
            child: ListTile(
              leading: IconButton(
                onPressed: () {
                  AppScope.of(context).socket.leaveChannel(channelKey);
                  setState(() {
                    _selected = null;
                    _messages = const [];
                    _pendingAttachments.clear();
                    _message.clear();
                  });
                  _setImmersive(false);
                },
                icon: const Icon(Icons.arrow_back),
              ),
              title: Text(_selected!.name),
              subtitle: Text(
                _selected!.isReadOnly
                    ? 'Read-only channel'
                    : (AppScope.of(context).socket.connected
                        ? 'Live'
                        : 'Reconnecting when possible'),
              ),
              trailing: _selected!.isReadOnly
                  ? null
                  : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (!_selected!.isDm)
                          IconButton(
                            tooltip: 'Channel settings',
                            onPressed: () => _showEditChannelSheet(_selected!),
                            icon: const Icon(Icons.settings_outlined),
                          ),
                        IconButton.filledTonal(
                          tooltip:
                              activeHuddle == null ? 'Start huddle' : 'Huddle',
                          onPressed: () => _showHuddleSheet(channelKey),
                          icon: Icon(
                            activeHuddle == null
                                ? Icons.call_outlined
                                : Icons.call,
                          ),
                        ),
                      ],
                    ),
            ),
          ),
        ),
        if (activeHuddle != null) _huddleBanner(channelKey, activeHuddle),
        Expanded(
          child: _loadingMessages
              ? const Center(child: CircularProgressIndicator())
              : displayMessages.isEmpty
                  ? const EmptyState(
                      icon: Icons.chat_bubble_outline,
                      title: 'No messages yet',
                      message: 'Messages and attachments will appear here.',
                    )
                  : ListView.builder(
                      reverse: true,
                      padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                      itemCount: displayMessages.length,
                      itemBuilder: (context, index) {
                        final message = displayMessages[index];
                        final mine = message.senderId == currentUserId;
                        return _messageRow(message, mine);
                      },
                    ),
        ),
        if (_selected!.isReadOnly)
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                'Availability updates are system generated and read-only.',
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
          )
        else
          _composer(),
      ],
    );
  }

  Widget _huddleBanner(String channelKey, JsonMap activeHuddle) {
    final scheme = Theme.of(context).colorScheme;
    final huddleId = readString(activeHuddle, ['huddleId', 'huddle_id']) ?? '';
    final joined = _joinedHuddles.contains(huddleId);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      color: scheme.primary,
      child: Row(
        children: [
          Icon(Icons.call, color: scheme.onPrimary, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              joined ? 'You are in this huddle' : 'Huddle live in this chat',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: scheme.onPrimary,
                    fontWeight: FontWeight.w800,
                  ),
            ),
          ),
          TextButton(
            onPressed: () => _showHuddleSheet(channelKey),
            style: TextButton.styleFrom(
              foregroundColor: scheme.onPrimary,
            ),
            child: Text(joined ? 'Manage' : 'Join'),
          ),
        ],
      ),
    );
  }

  Widget _messageRow(ChatMessage message, bool mine) {
    final scheme = Theme.of(context).colorScheme;
    final senderName =
        message.senderName ?? _nameForUser(message.senderId) ?? 'Teammate';
    final avatarUrl =
        message.senderAvatarUrl ?? _avatarUrlForUser(message.senderId);
    final bubbleColor = mine ? scheme.primary : scheme.surface;
    final textColor = mine ? scheme.onPrimary : scheme.onSurface;

    final bubble = Container(
      constraints: const BoxConstraints(maxWidth: 320),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: bubbleColor,
        borderRadius: BorderRadius.circular(8),
        border: mine ? null : Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!mine)
            Text(
              senderName,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: scheme.primary,
                    fontWeight: FontWeight.w800,
                  ),
            ),
          if (message.hasBody)
            MarkdownBody(
              data: message.text,
              styleSheet:
                  MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
                p: Theme.of(context)
                    .textTheme
                    .bodyMedium
                    ?.copyWith(color: textColor),
                strong:
                    TextStyle(color: textColor, fontWeight: FontWeight.w800),
                em: TextStyle(color: textColor, fontStyle: FontStyle.italic),
                code: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: textColor,
                      backgroundColor: mine
                          ? scheme.onPrimary.withValues(alpha: 0.16)
                          : scheme.surfaceContainerHighest,
                    ),
              ),
              onTapLink: (_, href, __) => _openUrl(href),
            )
          else if (message.attachments.isNotEmpty)
            Text(
              'Attachment',
              style: Theme.of(context)
                  .textTheme
                  .bodyMedium
                  ?.copyWith(color: textColor),
            ),
          if (message.attachments.isNotEmpty) ...[
            if (message.hasBody) const SizedBox(height: 8),
            for (final attachment in message.attachments)
              _attachmentPreview(attachment, mine),
          ],
          if (message.createdAt != null) ...[
            const SizedBox(height: 4),
            Text(
              longDateTime(message.createdAt),
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: mine
                        ? scheme.onPrimary.withValues(alpha: 0.78)
                        : scheme.onSurfaceVariant,
                  ),
            ),
          ],
        ],
      ),
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        mainAxisAlignment:
            mine ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!mine) ...[
            _Avatar(name: senderName, url: avatarUrl, size: 30),
            const SizedBox(width: 8),
          ],
          bubble,
          if (mine) ...[
            const SizedBox(width: 8),
            _Avatar(
              name: senderName,
              url: avatarUrl ?? AppScope.of(context).auth.user?.avatarUrl,
              size: 30,
            ),
          ],
        ],
      ),
    );
  }

  Widget _attachmentPreview(ChatAttachment attachment, bool mine) {
    final scheme = Theme.of(context).colorScheme;
    final labelColor = mine ? scheme.onPrimary : scheme.onSurface;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: InkWell(
        onTap: () => _openUrl(attachment.url),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          width: double.infinity,
          decoration: BoxDecoration(
            color: mine
                ? scheme.onPrimary.withValues(alpha: 0.12)
                : scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: mine
                  ? scheme.onPrimary.withValues(alpha: 0.22)
                  : scheme.outlineVariant,
            ),
          ),
          child: attachment.isImage
              ? ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Image.network(
                        attachment.url,
                        width: double.infinity,
                        height: 180,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) =>
                            _fileAttachmentRow(attachment, labelColor),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(8),
                        child: Text(
                          attachment.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context)
                              .textTheme
                              .labelMedium
                              ?.copyWith(color: labelColor),
                        ),
                      ),
                    ],
                  ),
                )
              : _fileAttachmentRow(attachment, labelColor),
        ),
      ),
    );
  }

  Widget _fileAttachmentRow(ChatAttachment attachment, Color labelColor) {
    return Padding(
      padding: const EdgeInsets.all(10),
      child: Row(
        children: [
          Icon(Icons.insert_drive_file_outlined, color: labelColor),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  attachment.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context)
                      .textTheme
                      .labelMedium
                      ?.copyWith(color: labelColor),
                ),
                if (attachment.type != null || attachment.size != null)
                  Text(
                    [attachment.type, _formatBytes(attachment.size)]
                        .whereType<String>()
                        .join(' - '),
                    style: Theme.of(context)
                        .textTheme
                        .labelSmall
                        ?.copyWith(color: labelColor.withValues(alpha: 0.74)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _composer() {
    final scheme = Theme.of(context).colorScheme;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
        decoration: BoxDecoration(
          color: scheme.surface,
          border: Border(top: BorderSide(color: scheme.outlineVariant)),
        ),
        child: Column(
          children: [
            if (_pendingAttachments.isNotEmpty || _uploadingAttachment)
              _pendingAttachmentStrip(),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                IconButton(
                  tooltip: 'Attach file',
                  onPressed: _uploadingAttachment ? null : _pickAttachments,
                  icon: _uploadingAttachment
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.attach_file),
                ),
                Expanded(
                  child: TextField(
                    controller: _message,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.newline,
                    decoration: const InputDecoration(hintText: 'Message'),
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: 'Formatting',
                  icon: const Icon(Icons.text_fields),
                  onSelected: (value) {
                    switch (value) {
                      case 'bold':
                        _wrapSelection('**', '**');
                        break;
                      case 'italic':
                        _wrapSelection('_', '_');
                        break;
                      case 'list':
                        _insertBullet();
                        break;
                      case 'code':
                        _wrapSelection('`', '`');
                        break;
                    }
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem(
                      value: 'bold',
                      child: ListTile(
                        leading: Icon(Icons.format_bold),
                        title: Text('Bold'),
                      ),
                    ),
                    PopupMenuItem(
                      value: 'italic',
                      child: ListTile(
                        leading: Icon(Icons.format_italic),
                        title: Text('Italic'),
                      ),
                    ),
                    PopupMenuItem(
                      value: 'list',
                      child: ListTile(
                        leading: Icon(Icons.format_list_bulleted),
                        title: Text('List'),
                      ),
                    ),
                    PopupMenuItem(
                      value: 'code',
                      child: ListTile(
                        leading: Icon(Icons.code),
                        title: Text('Code'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _sending ? null : _send,
                  icon: _sending
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _pendingAttachmentStrip() {
    return SizedBox(
      width: double.infinity,
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          if (_uploadingAttachment)
            const InputChip(
              avatar: SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              label: Text('Uploading'),
            ),
          for (final attachment in _pendingAttachments)
            InputChip(
              avatar: Icon(
                attachment.isImage
                    ? Icons.image_outlined
                    : Icons.insert_drive_file_outlined,
                size: 18,
              ),
              label: Text(attachment.name, overflow: TextOverflow.ellipsis),
              onDeleted: () =>
                  setState(() => _pendingAttachments.remove(attachment)),
            ),
        ],
      ),
    );
  }

  Future<void> _send() async {
    final text = _message.text.trim();
    final channel = _selected;
    final attachments = List<ChatAttachment>.from(_pendingAttachments);
    if (channel == null || (text.isEmpty && attachments.isEmpty)) return;
    final tempId =
        'mobile-${AppScope.of(context).auth.user?.id ?? 'user'}-${DateTime.now().microsecondsSinceEpoch}';
    setState(() {
      _sending = true;
      _pendingAttachments.clear();
    });
    _message.clear();

    try {
      final saved = await AppScope.of(context).api.sendMessage(
            channel.openKey,
            text,
            tempId: tempId,
            attachments: attachments,
          );
      if (!mounted || _selected?.openKey != channel.openKey) return;
      _upsertMessage(saved);
      AppScope.of(context).socket.markRead(channel.openKey);
    } catch (err) {
      if (!mounted) return;
      setState(() => _pendingAttachments.addAll(attachments));
      _message.text = text;
      showSnack(context, '$err');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _pickAttachments() async {
    final api = AppScope.of(context).api;
    try {
      final result = await FilePicker.platform.pickFiles(allowMultiple: true);
      if (result == null || result.files.isEmpty) return;
      setState(() => _uploadingAttachment = true);
      for (final picked in result.files) {
        final path = picked.path;
        if (path == null) continue;
        final uploaded = await api.uploadChatAttachment(File(path));
        if (!mounted) return;
        setState(() => _pendingAttachments.add(uploaded));
      }
    } catch (err) {
      if (mounted) showSnack(context, 'Attachment upload failed: $err');
    } finally {
      if (mounted) setState(() => _uploadingAttachment = false);
    }
  }

  void _wrapSelection(String before, String after) {
    final selection = _message.selection;
    final text = _message.text;
    if (!selection.isValid) {
      _message.text = '$text$before$after';
      _message.selection =
          TextSelection.collapsed(offset: _message.text.length - after.length);
      return;
    }
    final start = selection.start.clamp(0, text.length).toInt();
    final end = selection.end.clamp(0, text.length).toInt();
    final selected = text.substring(start, end);
    final next = text.replaceRange(start, end, '$before$selected$after');
    _message.text = next;
    _message.selection = TextSelection(
      baseOffset: start + before.length,
      extentOffset: start + before.length + selected.length,
    );
  }

  void _insertBullet() {
    final selection = _message.selection;
    final text = _message.text;
    final index = selection.isValid
        ? selection.start.clamp(0, text.length).toInt()
        : text.length;
    final prefix = index == 0 || text[index - 1] == '\n' ? '- ' : '\n- ';
    _message.text = text.replaceRange(index, index, prefix);
    _message.selection = TextSelection.collapsed(offset: index + prefix.length);
  }

  void _upsertMessage(ChatMessage message) {
    setState(() => _messages = _sortedUnique([..._messages, message]));
  }

  Future<void> _loadUnreadCounts() async {
    try {
      final counts = await AppScope.of(context).api.unreadCounts();
      if (mounted) setState(() => _unreadByChannel = counts);
    } catch (_) {}
  }

  Future<void> _markSelectedRead() async {
    final channelKey = _selected?.openKey;
    if (channelKey == null) return;
    AppScope.of(context).socket.markRead(channelKey);
    setState(() {
      final next = Map<String, int>.from(_unreadByChannel);
      next.remove(channelKey);
      _unreadByChannel = next;
    });
    try {
      await AppScope.of(context).api.markChatRead(channelKey);
    } catch (_) {}
  }

  void _bumpUnread(String channelKey) {
    if (_selected?.openKey == channelKey) {
      unawaited(_markSelectedRead());
      return;
    }
    setState(() {
      final next = Map<String, int>.from(_unreadByChannel);
      next[channelKey] = (next[channelKey] ?? 0) + 1;
      _unreadByChannel = next;
    });
  }

  void _handleSocketNotification(JsonMap event) {
    final channelKey =
        readString(event, ['channelKey', 'channel_id', 'channelId']);
    if (channelKey == null) return;
    _bumpUnread(channelKey);
  }

  void _openInitialChannelWhenReady(
    List<JsonMap> teammates,
    List<ChatChannel> channels,
  ) {
    final target = _pendingInitialChannelKey;
    if (target == null || _selected != null) return;
    _pendingInitialChannelKey = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _selected != null) return;
      final channel = channels.cast<ChatChannel?>().firstWhere(
            (item) => item?.openKey == target,
            orElse: () => null,
          );
      if (channel != null) {
        unawaited(_openChannel(channel));
        return;
      }
      if (target.startsWith('dm:')) {
        final ids = target.split(':').skip(1).toSet();
        final me = AppScope.of(context).auth.user?.id;
        ids.remove(me);
        final otherId = ids.isEmpty ? null : ids.first;
        final user = teammates.cast<JsonMap?>().firstWhere(
              (item) => item != null && '${item['id']}' == otherId,
              orElse: () => null,
            );
        if (user != null) {
          final name =
              readString(user, ['username', 'name', 'email']) ?? 'Teammate';
          unawaited(
            _openChannel(
              ChatChannel(id: target, key: target, name: name, type: 'dm'),
            ),
          );
        }
      }
    });
  }

  Future<void> _openInitialHuddleIfNeeded(String channelKey) async {
    final huddleId = _pendingInitialHuddleId;
    if (huddleId == null) return;
    _pendingInitialHuddleId = null;
    setState(() {
      _activeHuddles[channelKey] = {
        'event': 'started',
        'channelId': channelKey,
        'huddleId': huddleId,
      };
    });
    await _call?.join(
      channelId: channelKey,
      huddleId: huddleId,
      participants: _huddleParticipants[huddleId] ?? const [],
    );
    if (!mounted) return;
    setState(() => _joinedHuddles.add(huddleId));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _showHuddleSheet(channelKey);
    });
  }

  List<ChatMessage> _sortedUnique(List<ChatMessage> source) {
    final byKey = <String, ChatMessage>{};
    for (final message in source) {
      final key = message.stableKey;
      if (key.trim().isEmpty) continue;
      final existing = byKey[key];
      if (existing == null || (existing.id.isEmpty && message.id.isNotEmpty)) {
        byKey[key] = message;
      }
    }
    final messages = byKey.values.toList(growable: false);
    messages.sort((a, b) {
      final aTime = a.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      final bTime = b.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      return aTime.compareTo(bTime);
    });
    return messages;
  }

  void _handleHuddleEvent(JsonMap event) {
    final eventType = readString(event, ['event']);
    final action = readString(event, ['action']);
    final channelId =
        readString(event, ['channelId', 'channel_id']) ?? _call?.channelId;
    final huddleId =
        readString(event, ['huddleId', 'huddle_id']) ?? _call?.huddleId;

    if (eventType == 'error' &&
        (action == 'huddle:start' || action == 'huddle:join')) {
      if (channelId == null && huddleId == null) return;
      setState(() {
        _huddleActionMessage = null;
        if (channelId != null) _activeHuddles.remove(channelId);
        if (huddleId != null) {
          _joinedHuddles.remove(huddleId);
          _locallyStartedHuddles.remove(huddleId);
          _huddleParticipants.remove(huddleId);
        }
      });
      if (_call?.huddleId == huddleId || _call?.channelId == channelId) {
        unawaited(_call?.leave(emitLeave: false));
      }
      _bumpHuddleUi();
      return;
    }

    if (channelId == null || huddleId == null) return;
    setState(() {
      if (eventType == 'ended' || eventType == 'declined') {
        _huddleActionMessage = null;
        _activeHuddles.remove(channelId);
        _joinedHuddles.remove(huddleId);
        _locallyStartedHuddles.remove(huddleId);
        _huddleParticipants.remove(huddleId);
      } else {
        _activeHuddles[channelId] = event;
      }
    });
    _bumpHuddleUi();

    if (eventType == 'started') {
      unawaited(_joinStartedHuddleIfNeeded(event, channelId, huddleId));
    }
  }

  Future<void> _joinStartedHuddleIfNeeded(
    JsonMap event,
    String channelId,
    String huddleId,
  ) async {
    final call = _call;
    if (call == null) return;

    final startedBy = event['startedBy'];
    String? startedByUserId;
    if (startedBy is Map) {
      startedByUserId = readString(JsonMap.from(startedBy), [
        'userId',
        'user_id',
        'id',
      ]);
    } else {
      startedByUserId = readString(event, [
        'startedBy',
        'started_by',
        'startedByUserId',
      ]);
    }

    final currentUserId = AppScope.of(context).auth.user?.id;
    final alreadyJoined = _joinedHuddles.contains(huddleId) ||
        (call.joined == true && call.huddleId == huddleId);
    final shouldJoin = startedByUserId != null &&
        currentUserId != null &&
        startedByUserId.toString() == currentUserId.toString();
    final locallyStarted = _locallyStartedHuddles.contains(huddleId);

    if (!shouldJoin && !locallyStarted && !alreadyJoined) return;

    _setHuddleAction('Opening huddle...');
    try {
      await call.join(
        channelId: channelId,
        huddleId: huddleId,
        participants: _huddleParticipants[huddleId] ?? const [],
      );
      if (!mounted) return;
      setState(() => _joinedHuddles.add(huddleId));
      _bumpHuddleUi();
    } finally {
      if (mounted) _setHuddleAction(null);
    }
  }

  void _handleHuddleParticipantEvent(JsonMap event) {
    final huddleId = readString(event, ['huddleId', 'huddle_id']);
    if (huddleId == null) return;
    final participants =
        List<JsonMap>.from(_huddleParticipants[huddleId] ?? const []);
    if (event['event'] == 'participants' && event['participants'] is List) {
      final next = (event['participants'] as List)
          .whereType<Map>()
          .map((item) => JsonMap.from(item))
          .toList(growable: false);
      setState(() => _huddleParticipants[huddleId] = next);
      _bumpHuddleUi();
      return;
    }
    final userId = readString(event, ['userId', 'user_id']);
    if (userId == null) return;
    participants.removeWhere(
      (item) => readString(item, ['userId', 'user_id']) == userId,
    );
    if (event['event'] == 'joined') participants.add(event);
    setState(() => _huddleParticipants[huddleId] = participants);
    _bumpHuddleUi();
  }

  void _showCreateChannelSheet() {
    final nameController = TextEditingController();
    var isPrivate = false;
    final selectedMembers = <String>{};
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      showDragHandle: true,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setSheetState) {
            final bottom = MediaQuery.of(context).viewInsets.bottom;
            final users = _usersById.values.toList(growable: false);
            return Padding(
              padding: EdgeInsets.fromLTRB(18, 6, 18, 18 + bottom),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Create channel',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: nameController,
                    autofocus: true,
                    decoration:
                        const InputDecoration(labelText: 'Channel name'),
                  ),
                  const SizedBox(height: 10),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Private channel'),
                    subtitle: const Text('Only selected members can see it.'),
                    value: isPrivate,
                    onChanged: (value) =>
                        setSheetState(() => isPrivate = value),
                  ),
                  if (isPrivate && users.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(
                      'Members',
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                    const SizedBox(height: 6),
                    Flexible(
                      child: ListView(
                        shrinkWrap: true,
                        children: [
                          for (final user in users)
                            CheckboxListTile(
                              contentPadding: EdgeInsets.zero,
                              value: selectedMembers.contains('${user['id']}'),
                              title: Text(
                                readString(
                                      user,
                                      ['username', 'name', 'email'],
                                    ) ??
                                    'User',
                              ),
                              subtitle: Text(
                                readString(user, ['email', 'role']) ?? '',
                              ),
                              onChanged: (checked) {
                                final id = '${user['id']}';
                                setSheetState(() {
                                  if (checked == true) {
                                    selectedMembers.add(id);
                                  } else {
                                    selectedMembers.remove(id);
                                  }
                                });
                              },
                            ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: () async {
                        final name = nameController.text.trim();
                        if (name.isEmpty) return;
                        final api = AppScope.of(this.context).api;
                        try {
                          final channel = await api.createChannel(
                            name: name,
                            isPrivate: isPrivate,
                            members: selectedMembers.toList(growable: false),
                          );
                          if (!mounted || !context.mounted) return;
                          Navigator.of(context).pop();
                          await _refreshChannels();
                          await _openChannel(channel);
                        } catch (err) {
                          if (mounted) showSnack(this.context, '$err');
                        }
                      },
                      icon: const Icon(Icons.add),
                      label: const Text('Create channel'),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    ).whenComplete(nameController.dispose);
  }

  Future<void> _showEditChannelSheet(ChatChannel channel) async {
    final api = AppScope.of(context).api;
    final currentUserId = AppScope.of(context).auth.user?.id;
    final createdBy = readString(
      channel.raw,
      ['createdBy', 'created_by'],
    );
    var canManage = createdBy == currentUserId;
    try {
      final admins = await api.channelAdmins(channel.id);
      canManage = canManage ||
          admins.any(
            (admin) => readString(admin, ['id', 'user_id']) == currentUserId,
          );
    } catch (_) {}
    if (!mounted) return;

    final nameController = TextEditingController(text: channel.name);
    var isPrivate = channel.isPrivate;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      showDragHandle: true,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setSheetState) {
            final bottom = MediaQuery.of(context).viewInsets.bottom;
            return Padding(
              padding: EdgeInsets.fromLTRB(18, 6, 18, 18 + bottom),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Channel settings',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 12),
                  if (canManage) ...[
                    TextField(
                      controller: nameController,
                      autofocus: true,
                      decoration:
                          const InputDecoration(labelText: 'Channel name'),
                    ),
                    const SizedBox(height: 10),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Private channel'),
                      value: isPrivate,
                      onChanged: (value) =>
                          setSheetState(() => isPrivate = value),
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: () async {
                              final name = nameController.text.trim();
                              if (name.isEmpty) return;
                              final api = AppScope.of(this.context).api;
                              try {
                                final updated = await api.updateChannel(
                                  channelId: channel.id,
                                  name: name,
                                  isPrivate: isPrivate,
                                );
                                if (!mounted || !context.mounted) return;
                                Navigator.of(context).pop();
                                await _refreshChannels();
                                setState(() => _selected = updated);
                              } catch (err) {
                                if (mounted) showSnack(this.context, '$err');
                              }
                            },
                            icon: const Icon(Icons.save_outlined),
                            label: const Text('Save'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        IconButton.filledTonal(
                          tooltip: 'Delete channel',
                          onPressed: () async {
                            final api = AppScope.of(this.context).api;
                            final socket = AppScope.of(this.context).socket;
                            final confirm =
                                await _confirmDeleteChannel(channel.name);
                            if (confirm != true) return;
                            try {
                              await api.deleteChannel(channel.id);
                              if (!mounted || !context.mounted) return;
                              Navigator.of(context).pop();
                              socket.leaveChannel(channel.openKey);
                              setState(() {
                                _selected = null;
                                _messages = const [];
                              });
                              _setImmersive(false);
                              await _refreshChannels();
                            } catch (err) {
                              if (mounted) showSnack(this.context, '$err');
                            }
                          },
                          icon: const Icon(Icons.delete_outline),
                        ),
                      ],
                    ),
                  ] else ...[
                    const Text(
                      'You can leave this channel. Only channel admins can rename or delete it.',
                    ),
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        onPressed: () async {
                          try {
                            await api.leaveChannel(channel.id);
                            if (!mounted || !context.mounted) return;
                            Navigator.of(context).pop();
                            AppScope.of(this.context)
                                .socket
                                .leaveChannel(channel.openKey);
                            setState(() {
                              _selected = null;
                              _messages = const [];
                            });
                            _setImmersive(false);
                            await _refreshChannels();
                          } catch (err) {
                            if (mounted) showSnack(this.context, '$err');
                          }
                        },
                        icon: const Icon(Icons.logout),
                        label: const Text('Leave channel'),
                      ),
                    ),
                  ],
                ],
              ),
            );
          },
        );
      },
    );
    nameController.dispose();
  }

  Future<bool?> _confirmDeleteChannel(String name) {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete channel?'),
        content: Text('Delete "$name" and its channel membership?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }

  void _showHuddleSheet(String channelKey) {
    final socket = AppScope.of(context).socket;
    final active = _activeHuddles[channelKey];
    final initialHuddleId =
        readString(active ?? const {}, ['huddleId', 'huddle_id']);
    final initiallyJoined = initialHuddleId != null &&
        (_call?.joined == true && _call?.huddleId == initialHuddleId);
    _mobileHuddleControlsVisible = false;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: false,
      backgroundColor: Theme.of(context).colorScheme.surface,
      showDragHandle: false,
      enableDrag: false,
      isDismissible: !initiallyJoined,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setSheetState) {
            return ValueListenableBuilder<int>(
              valueListenable: _huddleUiVersion,
              builder: (context, _, __) {
                final current = _activeHuddles[channelKey] ?? active;
                final huddleId =
                    readString(current ?? const {}, ['huddleId', 'huddle_id']);
                final call = _call;
                final joined = huddleId != null &&
                    (call?.joined == true && call?.huddleId == huddleId);
                if (joined && call != null) {
                  return _fullscreenHuddle(
                    call,
                    channelKey,
                    huddleId,
                    setSheetState,
                  );
                }
                final participants = huddleId == null
                    ? const <JsonMap>[]
                    : (_huddleParticipants[huddleId] ?? const []);
                final huddleBusy =
                    _huddleActionMessage != null || (call?.starting == true);
                final huddleAction = _huddleActionMessage ??
                    (call?.starting == true ? 'Connecting media...' : null);
                final busyLabel = huddleAction == 'Starting huddle...'
                    ? 'Starting...'
                    : 'Joining...';
                final sheetHeight =
                    MediaQuery.of(context).size.height * (joined ? 0.92 : 0.58);
                return SizedBox(
                  height: sheetHeight,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(18, 6, 18, 18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                current == null ? 'Start huddle' : 'Huddle',
                                style: Theme.of(context)
                                    .textTheme
                                    .headlineSmall
                                    ?.copyWith(fontWeight: FontWeight.w800),
                              ),
                            ),
                            if (joined)
                              IconButton.filled(
                                tooltip: _selected?.isDm == true
                                    ? 'End call'
                                    : 'Leave call',
                                style: IconButton.styleFrom(
                                  backgroundColor:
                                      Theme.of(context).colorScheme.error,
                                  foregroundColor: Colors.white,
                                ),
                                onPressed: () async {
                                  await _leaveHuddle(channelKey, huddleId);
                                  if (context.mounted) {
                                    Navigator.of(context).pop();
                                  }
                                },
                                icon: const Icon(Icons.call_end),
                              ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          current == null
                              ? 'Start a live huddle in ${_selected?.name ?? 'this chat'}.'
                              : 'Live huddle in ${_selected?.name ?? 'this chat'}.',
                          style:
                              Theme.of(context).textTheme.bodyMedium?.copyWith(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurfaceVariant,
                                  ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Meeting intelligence is created after the huddle ends when transcription is available, whether the huddle was started on mobile or web.',
                          style:
                              Theme.of(context).textTheme.bodySmall?.copyWith(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurfaceVariant,
                                  ),
                        ),
                        if (huddleAction != null) ...[
                          const SizedBox(height: 12),
                          LinearProgressIndicator(
                            minHeight: 3,
                            borderRadius: BorderRadius.circular(999),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            huddleAction,
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                        ],
                        if (call?.error != null) ...[
                          const SizedBox(height: 10),
                          Text(
                            call!.error!,
                            style: Theme.of(context)
                                .textTheme
                                .bodySmall
                                ?.copyWith(
                                  color: Theme.of(context).colorScheme.error,
                                ),
                          ),
                        ],
                        if (joined && call != null) ...[
                          const SizedBox(height: 14),
                          Expanded(child: _huddleVideoGrid(call)),
                          const SizedBox(height: 12),
                          _huddleControls(
                            call,
                            channelKey,
                            huddleId,
                            setSheetState,
                          ),
                        ] else
                          const Spacer(),
                        if (participants.isNotEmpty) ...[
                          const SizedBox(height: 14),
                          Text(
                            'Participants',
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              for (final participant in participants)
                                Chip(
                                  avatar: _Avatar(
                                    name: readString(
                                          participant,
                                          ['username', 'name'],
                                        ) ??
                                        'User',
                                    size: 22,
                                  ),
                                  label: Text(
                                    readString(
                                          participant,
                                          ['username', 'name'],
                                        ) ??
                                        'User',
                                  ),
                                ),
                            ],
                          ),
                        ],
                        if (!joined) ...[
                          const SizedBox(height: 18),
                          Row(
                            children: [
                              if (current == null)
                                Expanded(
                                  child: FilledButton.icon(
                                    onPressed: socket.connected && !huddleBusy
                                        ? () async {
                                            await _startHuddle(channelKey);
                                            if (!context.mounted) return;
                                            setSheetState(() {});
                                          }
                                        : null,
                                    icon: huddleBusy
                                        ? const SizedBox(
                                            width: 18,
                                            height: 18,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 2,
                                            ),
                                          )
                                        : const Icon(Icons.call),
                                    label: Text(
                                      huddleBusy
                                          ? 'Starting...'
                                          : 'Start huddle',
                                    ),
                                  ),
                                )
                              else ...[
                                Expanded(
                                  child: FilledButton.icon(
                                    onPressed: socket.connected &&
                                            huddleId != null &&
                                            !huddleBusy
                                        ? () async {
                                            await _toggleJoinHuddle(
                                              channelKey,
                                              huddleId,
                                              participants,
                                              joined,
                                            );
                                            if (!context.mounted) return;
                                            setSheetState(() {});
                                          }
                                        : null,
                                    icon: huddleBusy
                                        ? const SizedBox(
                                            width: 18,
                                            height: 18,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 2,
                                            ),
                                          )
                                        : const Icon(Icons.call),
                                    label: Text(
                                      huddleBusy ? busyLabel : 'Join huddle',
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                IconButton.filledTonal(
                                  tooltip: _selected?.isDm == true
                                      ? 'End call'
                                      : 'End for all',
                                  onPressed: huddleId == null
                                      ? null
                                      : () async {
                                          await _endHuddleForAll(
                                            channelKey,
                                            huddleId,
                                          );
                                          if (context.mounted) {
                                            Navigator.of(context).pop();
                                          }
                                        },
                                  icon: const Icon(Icons.call_end),
                                ),
                              ],
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                );
              },
            );
          },
        );
      },
    );
  }

  Future<void> _startHuddle(String channelKey) async {
    final id = 'huddle-${DateTime.now().millisecondsSinceEpoch}';
    final scope = AppScope.of(context);
    final socket = scope.socket;
    final user = scope.auth.user;
    _setHuddleAction('Starting huddle...');
    _locallyStartedHuddles.add(id);
    setState(() {
      _activeHuddles[channelKey] = {
        'event': 'starting',
        'channelId': channelKey,
        'huddleId': id,
        'startedBy': {
          if (user?.id != null) 'userId': user!.id,
          if (user?.displayName != null) 'username': user!.displayName,
        },
      };
    });
    _bumpHuddleUi();
    socket.startHuddle(channelId: channelKey, huddleId: id);
    unawaited(
      Future<void>.delayed(const Duration(seconds: 8)).then((_) {
        if (!mounted || _huddleActionMessage != 'Starting huddle...') return;
        _setHuddleAction(null);
      }),
    );
  }

  Future<void> _toggleJoinHuddle(
    String channelKey,
    String huddleId,
    List<JsonMap> participants,
    bool joined,
  ) async {
    if (joined) return;
    _mobileHuddleControlsVisible = false;
    _setHuddleAction('Joining huddle...');
    try {
      await _call?.join(
        channelId: channelKey,
        huddleId: huddleId,
        participants: participants,
      );
      if (!mounted) return;
      setState(() => _joinedHuddles.add(huddleId));
      _bumpHuddleUi();
    } catch (_) {
      if (mounted) showSnack(context, 'Could not join huddle.');
    } finally {
      if (mounted) _setHuddleAction(null);
    }
  }

  Future<void> _leaveHuddle(String channelKey, String huddleId) async {
    await _call?.leave();
    if (!mounted) return;
    setState(() {
      _joinedHuddles.remove(huddleId);
      _locallyStartedHuddles.remove(huddleId);
      if (_selected?.isDm == true) {
        _activeHuddles.remove(channelKey);
        _huddleParticipants.remove(huddleId);
      }
    });
  }

  Future<void> _endHuddleForAll(String channelKey, String huddleId) async {
    final socket = AppScope.of(context).socket;
    await _call?.leave(emitLeave: false);
    socket.endHuddle(channelId: channelKey, huddleId: huddleId);
    if (!mounted) return;
    setState(() {
      _activeHuddles.remove(channelKey);
      _joinedHuddles.remove(huddleId);
      _locallyStartedHuddles.remove(huddleId);
      _huddleParticipants.remove(huddleId);
    });
  }

  Widget _huddleControls(
    HuddleCallController call,
    String channelKey,
    String? huddleId,
    void Function(void Function()) setSheetState,
  ) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        IconButton.filledTonal(
          tooltip: call.muted ? 'Unmute' : 'Mute',
          onPressed: () {
            call.setMuted(!call.muted);
            setSheetState(() {});
          },
          icon: Icon(call.muted ? Icons.mic_off : Icons.mic),
        ),
        const SizedBox(width: 12),
        IconButton.filledTonal(
          tooltip: call.cameraOn ? 'Camera off' : 'Camera on',
          onPressed: () {
            call.setCameraOn(!call.cameraOn);
            setSheetState(() {});
          },
          icon: Icon(call.cameraOn ? Icons.videocam : Icons.videocam_off),
        ),
        const SizedBox(width: 12),
        IconButton.filled(
          tooltip: _selected?.isDm == true ? 'End call' : 'Leave call',
          style: IconButton.styleFrom(
            backgroundColor: Theme.of(context).colorScheme.error,
            foregroundColor: Colors.white,
          ),
          onPressed: huddleId == null
              ? null
              : () => _leaveHuddle(channelKey, huddleId),
          icon: const Icon(Icons.call_end),
        ),
      ],
    );
  }

  Widget _fullscreenHuddle(
    HuddleCallController call,
    String channelKey,
    String? huddleId,
    void Function(void Function()) setSheetState,
  ) {
    return SizedBox(
      height: MediaQuery.sizeOf(context).height,
      child: ColoredBox(
        color: Colors.black,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () {
            setSheetState(() {
              _mobileHuddleControlsVisible = !_mobileHuddleControlsVisible;
            });
          },
          child: Stack(
            fit: StackFit.expand,
            children: [
              _fullscreenHuddleVideo(call),
              AnimatedPositioned(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOut,
                top: _mobileHuddleControlsVisible ? 0 : -96,
                left: 0,
                right: 0,
                child: IgnorePointer(
                  ignoring: !_mobileHuddleControlsVisible,
                  child: GestureDetector(
                    onTap: () {},
                    child: SafeArea(
                      bottom: false,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        decoration: const BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Color(0xCC000000),
                              Color(0x00000000),
                            ],
                          ),
                        ),
                        child: Row(
                          children: [
                            const Expanded(
                              child: Text(
                                'Huddle',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 17,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                            ),
                            IconButton(
                              tooltip: 'Hide controls',
                              onPressed: () {
                                setSheetState(
                                  () => _mobileHuddleControlsVisible = false,
                                );
                              },
                              color: Colors.white,
                              icon: const Icon(Icons.keyboard_arrow_down),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              AnimatedPositioned(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOut,
                left: 0,
                right: 0,
                bottom: _mobileHuddleControlsVisible ? 0 : -120,
                child: IgnorePointer(
                  ignoring: !_mobileHuddleControlsVisible,
                  child: GestureDetector(
                    onTap: () {},
                    child: SafeArea(
                      top: false,
                      child: Container(
                        padding: const EdgeInsets.fromLTRB(18, 18, 18, 12),
                        decoration: const BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Color(0x00000000),
                              Color(0xDD000000),
                            ],
                          ),
                        ),
                        child: _huddleControls(
                          call,
                          channelKey,
                          huddleId,
                          setSheetState,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _fullscreenHuddleVideo(HuddleCallController call) {
    final remoteIds = call.remoteUserIds;
    if (remoteIds.isEmpty) {
      return _videoTile(
        label: 'You',
        mediaView: call.buildLocalVideoView(mirror: true),
        renderer: call.localRenderer,
        mirror: true,
        objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
      );
    }

    final remoteStage = remoteIds.length == 1
        ? _videoTile(
            label: call.remoteNames[remoteIds.first] ??
                _nameForUser(remoteIds.first) ??
                'Teammate',
            mediaView: call.buildRemoteVideoView(remoteIds.first),
            renderer: call.remoteRenderers[remoteIds.first],
            emptyIcon: Icons.videocam_off_outlined,
            helper: 'Connecting video...',
            objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
          )
        : GridView.builder(
            padding: EdgeInsets.zero,
            itemCount: remoteIds.length,
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: remoteIds.length <= 2 ? 1 : 2,
              crossAxisSpacing: 4,
              mainAxisSpacing: 4,
              childAspectRatio: remoteIds.length <= 2 ? 3 / 4 : 1,
            ),
            itemBuilder: (context, index) {
              final id = remoteIds[index];
              return _videoTile(
                label: call.remoteNames[id] ?? _nameForUser(id) ?? 'Teammate',
                mediaView: call.buildRemoteVideoView(id),
                renderer: call.remoteRenderers[id],
                emptyIcon: Icons.videocam_off_outlined,
                helper: 'Connecting video...',
                objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
              );
            },
          );

    return Stack(
      fit: StackFit.expand,
      children: [
        remoteStage,
        Positioned(
          top: MediaQuery.paddingOf(context).top + 12,
          right: 12,
          width: 104,
          height: 144,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: Colors.black,
              border: Border.all(color: const Color(0x55FFFFFF)),
              borderRadius: BorderRadius.circular(10),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x66000000),
                  blurRadius: 14,
                  offset: Offset(0, 6),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(9),
              child: _videoTile(
                label: 'You',
                mediaView: call.buildLocalVideoView(mirror: true),
                renderer: call.localRenderer,
                mirror: true,
                compact: true,
                objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _huddleVideoGrid(HuddleCallController call) {
    final remoteIds = call.remoteUserIds;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: remoteIds.isEmpty
              ? _videoTile(
                  label: 'You',
                  mediaView: call.buildLocalVideoView(mirror: true),
                  renderer: call.localRenderer,
                  mirror: true,
                  objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
                )
              : GridView.builder(
                  itemCount: remoteIds.length,
                  gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: remoteIds.length == 1 ? 1 : 2,
                    crossAxisSpacing: 8,
                    mainAxisSpacing: 8,
                    childAspectRatio: 16 / 11,
                  ),
                  itemBuilder: (context, index) {
                    final id = remoteIds[index];
                    return _videoTile(
                      label: call.remoteNames[id] ??
                          _nameForUser(id) ??
                          'Teammate',
                      mediaView: call.buildRemoteVideoView(id),
                      renderer: call.remoteRenderers[id],
                      emptyIcon: Icons.videocam_off_outlined,
                      helper: 'Connecting video...',
                      objectFit:
                          RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
                    );
                  },
                ),
        ),
        if (remoteIds.isNotEmpty) ...[
          const SizedBox(height: 10),
          SizedBox(
            height: 148,
            child: _videoTile(
              label: 'You',
              mediaView: call.buildLocalVideoView(mirror: true),
              renderer: call.localRenderer,
              mirror: true,
              compact: true,
              objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
            ),
          ),
        ],
      ],
    );
  }

  Widget _videoTile({
    required String label,
    Widget? mediaView,
    RTCVideoRenderer? renderer,
    bool mirror = false,
    bool compact = false,
    IconData emptyIcon = Icons.person_outline,
    String? helper,
    RTCVideoViewObjectFit objectFit =
        RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final hasStream = renderer?.srcObject != null;
    final hasMediaView = mediaView != null;
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: Stack(
        fit: StackFit.expand,
        children: [
          Container(color: scheme.surfaceContainerHighest),
          if (hasMediaView)
            mediaView
          else if (hasStream)
            RTCVideoView(
              renderer!,
              mirror: mirror,
              objectFit: objectFit,
            )
          else
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    emptyIcon,
                    color: scheme.onSurfaceVariant,
                    size: compact ? 24 : 42,
                  ),
                  if (helper != null && !compact) ...[
                    const SizedBox(height: 8),
                    Text(
                      helper,
                      textAlign: TextAlign.center,
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ],
                ],
              ),
            ),
          Positioned(
            left: 8,
            bottom: 8,
            right: 8,
            child: Align(
              alignment: Alignment.bottomLeft,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context)
                        .textTheme
                        .labelMedium
                        ?.copyWith(color: Colors.white),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _openUrl(String? rawUrl) async {
    if (rawUrl == null || rawUrl.trim().isEmpty) return;
    final uri = Uri.tryParse(rawUrl);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  String? _nameForUser(String? userId) {
    if (userId == null) return null;
    final user = _usersById[userId];
    if (user == null) return null;
    return readString(user, ['username', 'name', 'email']);
  }

  String? _avatarUrlForUser(String? userId) {
    if (userId == null) return null;
    final user = _usersById[userId];
    if (user == null) return null;
    return readString(user, ['avatarUrl', 'avatar_url', 'picture']);
  }

  String? _formatBytes(int? bytes) {
    if (bytes == null) return null;
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({
    required this.name,
    this.url,
    this.size = 40,
  });

  final String name;
  final String? url;
  final double size;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final imageUrl = url?.trim();
    final trimmed = name.trim();
    final initial =
        trimmed.isEmpty ? 'U' : trimmed.substring(0, 1).toUpperCase();
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: scheme.surfaceContainerHighest,
      foregroundColor: scheme.primary,
      backgroundImage:
          imageUrl == null || imageUrl.isEmpty ? null : NetworkImage(imageUrl),
      child: imageUrl == null || imageUrl.isEmpty
          ? Text(
              initial,
              style:
                  TextStyle(fontSize: size * 0.38, fontWeight: FontWeight.w800),
            )
          : null,
    );
  }
}

class _UnreadBadge extends StatelessWidget {
  const _UnreadBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const Icon(Icons.chevron_right);
    final scheme = Theme.of(context).colorScheme;
    final label = count > 99 ? '99+' : '$count';
    return Container(
      constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: scheme.primary,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: scheme.onPrimary,
              fontWeight: FontWeight.w800,
            ),
      ),
    );
  }
}
