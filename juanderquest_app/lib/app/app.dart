import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'router.dart';

class JuanderQuestApp extends StatelessWidget {
  const JuanderQuestApp({super.key});

  @override
  Widget build(BuildContext context) {
    const primaryGold = Color(0xFFFFB703);
    const secondaryGreen = Color(0xFF3F6653);
    const backgroundWarm = Color(0xFFFAF9F5);
    const woodBrown = Color(0xFF582F0E);
    const deepInk = Color(0xFF0D1B2A);

    final textTheme = TextTheme(
      displayLarge: GoogleFonts.epilogue(fontSize: 32, fontWeight: FontWeight.w700, color: woodBrown),
      displayMedium: GoogleFonts.epilogue(fontSize: 24, fontWeight: FontWeight.w700, color: woodBrown),
      displaySmall: GoogleFonts.epilogue(fontSize: 20, fontWeight: FontWeight.w600, color: woodBrown),
      headlineMedium: GoogleFonts.epilogue(fontSize: 18, fontWeight: FontWeight.w600, color: deepInk),
      bodyLarge: GoogleFonts.plusJakartaSans(fontSize: 16, fontWeight: FontWeight.w400, color: deepInk),
      bodyMedium: GoogleFonts.plusJakartaSans(fontSize: 14, fontWeight: FontWeight.w400, color: const Color(0xFF514532)),
      labelLarge: GoogleFonts.plusJakartaSans(fontSize: 14, fontWeight: FontWeight.w600, color: deepInk),
    );

    return MaterialApp.router(
      title: 'JuanderQuest',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        scaffoldBackgroundColor: backgroundWarm,
        primaryColor: primaryGold,
        colorScheme: ColorScheme.fromSeed(
          seedColor: primaryGold,
          primary: primaryGold,
          secondary: secondaryGreen,
          surface: backgroundWarm,
          surfaceContainer: const Color(0xFFEFEEEA),
        ),
        textTheme: textTheme,
        appBarTheme: AppBarTheme(
          backgroundColor: backgroundWarm,
          elevation: 0,
          scrolledUnderElevation: 0.5,
          titleTextStyle: GoogleFonts.epilogue(
            color: woodBrown,
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
          iconTheme: const IconThemeData(color: woodBrown),
        ),
      ),
      routerConfig: appRouter,
    );
  }
}
