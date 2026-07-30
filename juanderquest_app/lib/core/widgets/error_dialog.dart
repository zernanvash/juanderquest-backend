import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class GlobalErrorDialog extends StatelessWidget {
  final String title;
  final String message;
  final IconData icon;
  final Color iconColor;
  final String buttonText;
  final VoidCallback? onPressed;

  const GlobalErrorDialog({
    super.key,
    required this.title,
    required this.message,
    this.icon = Icons.error_outline_rounded,
    this.iconColor = const Color(0xFFBC4749),
    this.buttonText = 'Understand',
    this.onPressed,
  });

  static Future<void> show(
    BuildContext context, {
    required String title,
    required String message,
    IconData icon = Icons.error_outline_rounded,
    Color iconColor = const Color(0xFFBC4749),
    String buttonText = 'Understand',
    VoidCallback? onPressed,
  }) {
    return showDialog(
      context: context,
      barrierDismissible: true,
      builder: (ctx) => GlobalErrorDialog(
        title: title,
        message: message,
        icon: icon,
        iconColor: iconColor,
        buttonText: buttonText,
        onPressed: onPressed,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      backgroundColor: const Color(0xFFFAF9F5),
      elevation: 8,
      child: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Header Icon Badge
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: iconColor.withValues(alpha: 0.12),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, color: iconColor, size: 36),
            ),
            const SizedBox(height: 16),

            // Title
            Text(
              title,
              textAlign: TextAlign.center,
              style: GoogleFonts.epilogue(
                color: const Color(0xFF582F0E),
                fontSize: 20,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 10),

            // Message Body
            Text(
              message,
              textAlign: TextAlign.center,
              style: GoogleFonts.plusJakartaSans(
                color: const Color(0xFF514532),
                fontSize: 14,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 24),

            // Action Button
            ElevatedButton(
              onPressed: () {
                Navigator.of(context).pop();
                if (onPressed != null) onPressed!();
              },
              style: ElevatedButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
                backgroundColor: const Color(0xFFFFB703),
                foregroundColor: const Color(0xFF6B4B00),
                elevation: 2,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              child: Text(
                buttonText,
                style: GoogleFonts.epilogue(
                  fontSize: 15,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
