// lib/src/config/app_theme.dart
//
// Builds ThemeData from the design tokens. Every screen reads its styling from
// here via Theme.of(context), so the whole app restyles from one place and
// light mode stays correct without touching screen code.

import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/theme_store.dart';
import 'design_tokens.dart';

abstract final class AppTheme {
  /// Resolve which palette to use for a given user selection and system setting.
  static AppPalette paletteFor(
    AppThemeOption option,
    Brightness systemBrightness,
  ) {
    switch (option) {
      case AppThemeOption.light:
        return AppPalettes.light();
      case AppThemeOption.dark:
        return AppPalettes.dark();
      case AppThemeOption.ocean:
        return AppPalettes.ocean();
      case AppThemeOption.forest:
        return AppPalettes.forest();
      case AppThemeOption.sunset:
        return AppPalettes.sunset();
      case AppThemeOption.yellow:
        return AppPalettes.yellow();
      case AppThemeOption.system:
        return systemBrightness == Brightness.light
            ? AppPalettes.light()
            : AppPalettes.dark();
    }
  }

  /// Type scale.
  ///
  /// Note: no custom fontFamily is set. The previous theme asked for 'Inter',
  /// but no Inter files are bundled, so it silently fell back to the platform
  /// font anyway. Using the platform font deliberately (Roboto on Android, SF
  /// on iOS) is both honest and better — those are designed for their OS —
  /// with the scale, weights and letter-spacing tuned here instead.
  static TextTheme _textTheme(AppPalette p) {
    // Tighter tracking on large text, slightly looser on small text: the
    // standard optical correction that makes headings feel composed and small
    // labels stay legible.
    TextStyle h(double size, FontWeight weight, double spacing) => TextStyle(
          fontSize: size,
          fontWeight: weight,
          letterSpacing: spacing,
          color: p.text,
          height: 1.25,
        );
    TextStyle b(double size, FontWeight weight, Color color, double height) =>
        TextStyle(
          fontSize: size,
          fontWeight: weight,
          color: color,
          height: height,
          letterSpacing: 0.1,
        );

    return TextTheme(
      displaySmall: h(30, FontWeight.w700, -0.6),
      headlineLarge: h(26, FontWeight.w700, -0.5),
      headlineMedium: h(22, FontWeight.w700, -0.4),
      headlineSmall: h(19, FontWeight.w700, -0.25),
      titleLarge: h(17, FontWeight.w700, -0.15),
      titleMedium: h(15, FontWeight.w600, -0.1),
      titleSmall: h(13.5, FontWeight.w600, 0),
      bodyLarge: b(15, FontWeight.w400, p.text, 1.45),
      bodyMedium: b(13.5, FontWeight.w400, p.textMuted, 1.45),
      bodySmall: b(12, FontWeight.w400, p.textMuted, 1.4),
      labelLarge: b(13.5, FontWeight.w600, p.text, 1.2),
      labelMedium: b(12, FontWeight.w600, p.textMuted, 1.2),
      labelSmall: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        color: p.textSoft,
        letterSpacing: 0.4,
        height: 1.2,
      ),
    );
  }

  static ThemeData build(AppPalette p) {
    final colorScheme = ColorScheme(
      brightness: p.brightness,
      primary: p.primary,
      onPrimary: p.primaryContrast,
      primaryContainer: p.primarySoft,
      onPrimaryContainer: p.primary,
      secondary: p.primaryHover,
      onSecondary: p.primaryContrast,
      surface: p.surface,
      onSurface: p.text,
      surfaceContainerLowest: p.appBg,
      surfaceContainerLow: p.surface,
      surfaceContainer: p.surfaceSoft,
      surfaceContainerHigh: p.surfaceSoft,
      surfaceContainerHighest: p.surfaceStrong,
      onSurfaceVariant: p.textMuted,
      outline: p.border,
      outlineVariant: p.borderStrong,
      error: p.status.danger,
      onError: p.isDark ? const Color(0xff1a0000) : Colors.white,
      errorContainer: p.status.dangerSoft,
      onErrorContainer: p.status.danger,
      shadow: p.shadow,
      scrim: Colors.black54,
      inverseSurface: p.text,
      onInverseSurface: p.appBg,
      inversePrimary: p.primaryHover,
    );

    final text = _textTheme(p);

    return ThemeData(
      useMaterial3: true,
      brightness: p.brightness,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: p.appBg,
      canvasColor: p.appBg,
      textTheme: text,
      extensions: [p],
      splashFactory: InkSparkle.splashFactory,

      // Match the system bars to the app so the status bar doesn't sit as a
      // mismatched strip above the UI.
      appBarTheme: AppBarTheme(
        backgroundColor: p.appBg,
        foregroundColor: p.text,
        surfaceTintColor: Colors.transparent,
        scrolledUnderElevation: 0,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: text.titleLarge,
        systemOverlayStyle: p.isDark
            ? SystemUiOverlayStyle.light.copyWith(
                statusBarColor: Colors.transparent,
                systemNavigationBarColor: p.appBg,
                systemNavigationBarIconBrightness: Brightness.light,
              )
            : SystemUiOverlayStyle.dark.copyWith(
                statusBarColor: Colors.transparent,
                systemNavigationBarColor: p.appBg,
                systemNavigationBarIconBrightness: Brightness.dark,
              ),
      ),

      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        color: p.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: Radii.cardRadius,
          side: BorderSide(color: p.border),
        ),
      ),

      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: p.surface,
        modalBackgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        dragHandleColor: p.borderStrong,
        showDragHandle: true,
        shape: RoundedRectangleBorder(borderRadius: Radii.sheetRadius),
        clipBehavior: Clip.antiAlias,
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.xl),
          side: BorderSide(color: p.border),
        ),
        titleTextStyle: text.headlineSmall,
        contentTextStyle: text.bodyMedium,
      ),

      chipTheme: ChipThemeData(
        backgroundColor: p.surfaceSoft,
        selectedColor: p.primarySoft,
        disabledColor: p.surfaceSoft,
        secondarySelectedColor: p.primarySoft,
        labelStyle: text.labelMedium!.copyWith(color: p.text),
        secondaryLabelStyle: text.labelMedium!.copyWith(color: p.primary),
        side: BorderSide(color: p.border),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.pill),
        ),
        padding: const EdgeInsets.symmetric(
          horizontal: Insets.sm,
          vertical: Insets.xxs,
        ),
        showCheckmark: false,
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.isDark ? p.surfaceSoft : p.surface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: Insets.md,
          vertical: Insets.sm + 2,
        ),
        labelStyle: text.bodyMedium,
        floatingLabelStyle: TextStyle(color: p.primary, fontSize: 13),
        hintStyle: text.bodyMedium!.copyWith(color: p.textSoft),
        prefixIconColor: p.textSoft,
        suffixIconColor: p.textSoft,
        border: OutlineInputBorder(
          borderRadius: Radii.controlRadius,
          borderSide: BorderSide(color: p.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: Radii.controlRadius,
          borderSide: BorderSide(color: p.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: Radii.controlRadius,
          borderSide: BorderSide(color: p.primary, width: 1.6),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: Radii.controlRadius,
          borderSide: BorderSide(color: p.status.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: Radii.controlRadius,
          borderSide: BorderSide(color: p.status.danger, width: 1.6),
        ),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: p.textMuted,
        textColor: p.text,
        titleTextStyle: text.titleMedium,
        subtitleTextStyle: text.bodySmall,
        tileColor: Colors.transparent,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: Insets.md,
          vertical: Insets.xxs,
        ),
        shape: RoundedRectangleBorder(borderRadius: Radii.controlRadius),
      ),

      // 46px min height: comfortably above the 44px touch-target guidance.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: p.primary,
          foregroundColor: p.primaryContrast,
          disabledBackgroundColor: p.surfaceStrong,
          disabledForegroundColor: p.textSoft,
          minimumSize: const Size(0, 46),
          padding: const EdgeInsets.symmetric(horizontal: Insets.lg),
          shape: RoundedRectangleBorder(borderRadius: Radii.controlRadius),
          textStyle: text.labelLarge!.copyWith(fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: p.text,
          side: BorderSide(color: p.borderStrong),
          minimumSize: const Size(0, 46),
          padding: const EdgeInsets.symmetric(horizontal: Insets.lg),
          shape: RoundedRectangleBorder(borderRadius: Radii.controlRadius),
          textStyle: text.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: p.primary,
          minimumSize: const Size(0, 40),
          padding: const EdgeInsets.symmetric(horizontal: Insets.sm),
          shape: RoundedRectangleBorder(borderRadius: Radii.controlRadius),
          textStyle: text.labelLarge,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          foregroundColor: p.textMuted,
          minimumSize: const Size(40, 40),
          shape: RoundedRectangleBorder(borderRadius: Radii.controlRadius),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: p.primary,
        foregroundColor: p.primaryContrast,
        elevation: 0,
        focusElevation: 0,
        hoverElevation: 0,
        highlightElevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
      ),

      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: p.isDark ? p.surface : p.surface,
        indicatorColor: p.primarySoft,
        elevation: 0,
        height: 64,
        surfaceTintColor: Colors.transparent,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        indicatorShape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.pill),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            size: 22,
            color:
                states.contains(WidgetState.selected) ? p.primary : p.textMuted,
          ),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            fontSize: 11,
            letterSpacing: 0.2,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w700
                : FontWeight.w500,
            color:
                states.contains(WidgetState.selected) ? p.primary : p.textMuted,
          ),
        ),
      ),

      drawerTheme: DrawerThemeData(
        backgroundColor: p.appBg,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius:
              BorderRadius.horizontal(right: Radius.circular(Radii.xl)),
        ),
      ),

      popupMenuTheme: PopupMenuThemeData(
        color: p.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        textStyle: text.bodyLarge,
        shape: RoundedRectangleBorder(
          borderRadius: Radii.controlRadius,
          side: BorderSide(color: p.border),
        ),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: p.isDark ? p.surfaceStrong : const Color(0xff26262b),
        contentTextStyle: const TextStyle(color: Colors.white, fontSize: 13.5),
        actionTextColor: p.primary,
        behavior: SnackBarBehavior.floating,
        insetPadding: const EdgeInsets.all(Insets.md),
        shape: RoundedRectangleBorder(borderRadius: Radii.controlRadius),
        elevation: 0,
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? p.primaryContrast
              : p.textMuted,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? p.primary : p.surfaceStrong,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? p.primary : p.border,
        ),
      ),
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (s) =>
              s.contains(WidgetState.selected) ? p.primary : Colors.transparent,
        ),
        checkColor: WidgetStateProperty.all(p.primaryContrast),
        side: BorderSide(color: p.borderStrong, width: 1.5),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.xs - 2),
        ),
      ),
      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? p.primary : p.borderStrong,
        ),
      ),

      dividerTheme: DividerThemeData(
        color: p.border,
        thickness: 1,
        space: 1,
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: p.primary,
        linearTrackColor: p.surfaceStrong,
        circularTrackColor: Colors.transparent,
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: p.isDark ? p.surfaceStrong : const Color(0xff26262b),
          borderRadius: BorderRadius.circular(Radii.xs),
        ),
        textStyle: const TextStyle(color: Colors.white, fontSize: 12),
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: p.primary,
        unselectedLabelColor: p.textMuted,
        indicatorColor: p.primary,
        indicatorSize: TabBarIndicatorSize.label,
        dividerColor: p.border,
        labelStyle: text.labelLarge,
        unselectedLabelStyle: text.labelLarge!.copyWith(
          fontWeight: FontWeight.w500,
        ),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: p.primary,
        selectionColor: p.primary.withValues(alpha: 0.28),
        selectionHandleColor: p.primary,
      ),

      // Consistent, platform-appropriate page motion.
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: CupertinoPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }
}
