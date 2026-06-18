import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum AppThemeOption {
  system('system', 'System'),
  light('light', 'Light'),
  dark('dark', 'Dark'),
  ocean('ocean', 'Ocean'),
  forest('forest', 'Forest'),
  sunset('sunset', 'Sunset'),
  yellow('yellow', 'Yellow');

  const AppThemeOption(this.key, this.label);

  final String key;
  final String label;

  ThemeMode get themeMode {
    switch (this) {
      case AppThemeOption.system:
        return ThemeMode.system;
      case AppThemeOption.light:
        return ThemeMode.light;
      default:
        return ThemeMode.dark;
    }
  }

  static AppThemeOption fromKey(String? key) {
    return values.firstWhere(
      (option) => option.key == key,
      orElse: () => AppThemeOption.system,
    );
  }
}

class ThemeStore extends ChangeNotifier {
  static const _storageKey = 'asystence.appearance.theme';

  AppThemeOption _selection = AppThemeOption.system;

  AppThemeOption get selection => _selection;

  Future<void> restore() async {
    final preferences = await SharedPreferences.getInstance();
    _selection = AppThemeOption.fromKey(preferences.getString(_storageKey));
  }

  Future<void> select(AppThemeOption option) async {
    if (_selection == option) return;
    _selection = option;
    notifyListeners();
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(_storageKey, option.key);
  }
}
