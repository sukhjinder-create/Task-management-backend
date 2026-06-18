import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../config/app_config.dart';
import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  bool _busy = false;
  bool _ready = false;
  bool _muteAll = false;
  bool _muteTasks = false;
  bool _muteChat = false;
  late Future<void> _preferencesFuture;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _preferencesFuture = _loadPreferences();
      _ready = true;
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.of(context).auth;
    final user = auth.user;
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionCard(
            child: Row(
              children: [
                CircleAvatar(
                  radius: 34,
                  backgroundColor: AppConfig.surfaceStrong,
                  backgroundImage: user?.avatarUrl == null
                      ? null
                      : NetworkImage(user!.avatarUrl!),
                  child: user?.avatarUrl == null
                      ? Text(_initial(user?.displayName))
                      : null,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        user?.displayName ?? 'User',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      Text(user?.email ?? ''),
                      const SizedBox(height: 6),
                      StatusChip(
                        label: user?.role ?? 'user',
                        tone: ChipTone.info,
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Change photo',
                  onPressed: _busy ? null : _changePhoto,
                  icon: const Icon(Icons.photo_camera_outlined),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          SectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Attendance',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton.icon(
                      onPressed: _busy ? null : () => _attendance('sign-in'),
                      icon: const Icon(Icons.login),
                      label: const Text('Sign in'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _busy ? null : () => _attendance('available'),
                      icon: const Icon(Icons.check_circle_outline),
                      label: const Text('Available'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _busy ? null : () => _attendance('lunch'),
                      icon: const Icon(Icons.restaurant_outlined),
                      label: const Text('Lunch'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _busy
                          ? null
                          : () => _attendance('aws', body: {'minutes': 30}),
                      icon: const Icon(Icons.timer_outlined),
                      label: const Text('AWS 30'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _busy ? null : () => _attendance('sign-off'),
                      icon: const Icon(Icons.logout),
                      label: const Text('Sign off'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          SectionCard(
            child: FutureBuilder<void>(
              future: _preferencesFuture,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  final error = snapshot.error;
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Notifications',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        error is ApiException ? error.message : '$error',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                      TextButton(
                        onPressed: () {
                          setState(
                            () => _preferencesFuture = _loadPreferences(),
                          );
                        },
                        child: const Text('Retry'),
                      ),
                    ],
                  );
                }
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Notifications',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Mute all'),
                      value: _muteAll,
                      onChanged: _busy
                          ? null
                          : (value) => _savePreferences(muteAll: value),
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Task updates'),
                      subtitle: const Text('Assignments and task changes'),
                      value: _muteTasks,
                      onChanged: _busy || _muteAll
                          ? null
                          : (value) => _savePreferences(muteTasks: value),
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Chat messages'),
                      value: _muteChat,
                      onChanged: _busy || _muteAll
                          ? null
                          : (value) => _savePreferences(muteChat: value),
                    ),
                  ],
                );
              },
            ),
          ),
          const SizedBox(height: 12),
          SectionCard(
            child: Column(
              children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.refresh),
                  title: const Text('Refresh profile'),
                  onTap: () async {
                    await auth.refreshMe();
                    if (context.mounted) {
                      showSnack(context, 'Profile refreshed');
                    }
                  },
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.password),
                  title: const Text('Change password'),
                  onTap: _changePassword,
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.logout),
                  title: const Text('Sign out'),
                  onTap: auth.logout,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _attendance(
    String action, {
    Map<String, dynamic> body = const {},
  }) async {
    setState(() => _busy = true);
    try {
      await AppScope.of(context).api.attendance(action, body: body);
      if (mounted) showSnack(context, 'Attendance updated');
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadPreferences() async {
    final data = await AppScope.of(context).api.notificationPreferences();
    _muteAll = readBool(data, ['mute_all']);
    _muteTasks = readBool(data, ['mute_tasks']);
    _muteChat = readBool(data, ['mute_chat']);
  }

  Future<void> _savePreferences({
    bool? muteAll,
    bool? muteTasks,
    bool? muteChat,
  }) async {
    final previous = (_muteAll, _muteTasks, _muteChat);
    setState(() {
      _busy = true;
      _muteAll = muteAll ?? _muteAll;
      _muteTasks = muteTasks ?? _muteTasks;
      _muteChat = muteChat ?? _muteChat;
    });
    try {
      await AppScope.of(context).api.updateNotificationPreferences(
            muteAll: _muteAll,
            muteTasks: _muteTasks,
            muteChat: _muteChat,
          );
      if (mounted) showSnack(context, 'Notification preferences saved');
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _muteAll = previous.$1;
        _muteTasks = previous.$2;
        _muteChat = previous.$3;
      });
      showSnack(context, '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changePhoto() async {
    final scope = AppScope.of(context);
    final result = await FilePicker.platform.pickFiles(type: FileType.image);
    final path = result?.files.single.path;
    if (path == null) return;
    setState(() => _busy = true);
    try {
      await scope.api.uploadAvatar(File(path));
      await scope.auth.refreshMe();
      if (mounted) showSnack(context, 'Profile photo updated');
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changePassword() async {
    final api = AppScope.of(context).api;
    final auth = AppScope.of(context).auth;
    final payload = await showJsonFormSheet(
      context,
      title: 'Change password',
      fields: const [
        TextFieldSpec(
          key: 'currentPassword',
          label: 'Current password',
          isRequired: true,
        ),
        TextFieldSpec(
          key: 'newPassword',
          label: 'New password',
          isRequired: true,
        ),
      ],
    );
    if (payload == null) return;
    try {
      await api.putMap('/auth/change-password', body: payload);
      if (mounted) {
        showSnack(context, 'Password changed. Please sign in again.');
        await auth.logout();
      }
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  String _initial(String? value) {
    final text = (value == null || value.trim().isEmpty) ? 'A' : value.trim();
    return text.substring(0, 1).toUpperCase();
  }
}
