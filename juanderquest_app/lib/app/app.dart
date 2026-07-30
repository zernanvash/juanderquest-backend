import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'router.dart';

class JuanderQuestApp extends StatelessWidget {
  const JuanderQuestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'JuanderQuest',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF0A0F1D),
        primaryColor: const Color(0xFF00F2FE),
        textTheme: GoogleFonts.plusJakartaSansTextTheme(
          ThemeData.dark().textTheme,
        ),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF00F2FE),
          secondary: Color(0xFFFFB703),
          surface: Color(0xFF131B2E),
        ),
      ),
      routerConfig: appRouter,
    );
  }
}
