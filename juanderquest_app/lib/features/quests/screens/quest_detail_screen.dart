import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:permission_handler/permission_handler.dart';
import '../models/quest_model.dart';

class QuestDetailScreen extends StatelessWidget {
  final QuestModel quest;

  const QuestDetailScreen({super.key, required this.quest});

  Future<void> _launchAR(BuildContext context) async {
    final cameraStatus = await Permission.camera.request();
    final locationStatus = await Permission.locationWhenInUse.request();

    if (cameraStatus.isGranted && locationStatus.isGranted) {
      if (context.mounted) {
        context.push('/ar', extra: quest);
      }
    } else {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Camera and Location permissions are required for quest verification.',
              style: GoogleFonts.plusJakartaSans(),
            ),
            backgroundColor: const Color(0xFFBC4749),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        title: Text(
          quest.title,
          style: GoogleFonts.epilogue(fontSize: 16, color: const Color(0xFF582F0E)),
        ),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Color(0xFF582F0E)),
          onPressed: () => context.pop(),
        ),
      ),
      body: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Destination Banner Image Box
            Container(
              height: 220,
              decoration: const BoxDecoration(
                image: DecorationImage(
                  image: AssetImage('assets/images/pangasinan_banner.png'),
                  fit: BoxFit.cover,
                ),
              ),
              child: Stack(
                children: [
                  Container(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [
                          Colors.black.withValues(alpha: 0.7),
                          Colors.transparent,
                        ],
                        begin: Alignment.bottomCenter,
                        end: Alignment.topCenter,
                      ),
                    ),
                  ),
                  Positioned(
                    bottom: 16,
                    left: 16,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFF3F6653),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        quest.category.toUpperCase(),
                        style: GoogleFonts.plusJakartaSans(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 11,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),

            Padding(
              padding: const EdgeInsets.all(20.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Title & Reward Points Badge
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          quest.title,
                          style: GoogleFonts.epilogue(
                            color: const Color(0xFF582F0E),
                            fontSize: 22,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFB703),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text(
                          '+${quest.rewardPoints} PTS',
                          style: GoogleFonts.epilogue(
                            color: const Color(0xFF6B4B00),
                            fontWeight: FontWeight.bold,
                            fontSize: 14,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      const Icon(Icons.location_on, color: Color(0xFF7D5800), size: 16),
                      const SizedBox(width: 6),
                      Text(
                        quest.locationName,
                        style: GoogleFonts.plusJakartaSans(
                          color: const Color(0xFF514532),
                          fontSize: 14,
                        ),
                      ),
                    ],
                  ),
                  const Divider(color: Color(0xFFD5C4AC), height: 32),

                  // Description
                  Text(
                    'About Destination',
                    style: GoogleFonts.epilogue(
                      color: const Color(0xFF1B1C1A),
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    quest.description,
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF514532),
                      fontSize: 14,
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 24),

                  // 3-Step Instructions Card
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '3 Steps to Complete Quest',
                          style: GoogleFonts.epilogue(
                            color: const Color(0xFF582F0E),
                            fontSize: 15,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 12),
                        _buildStepRow('1', 'Travel to location in Pangasinan'),
                        const SizedBox(height: 8),
                        _buildStepRow('2', 'Locate the physical quest marker'),
                        const SizedBox(height: 8),
                        _buildStepRow('3', 'Scan marker & submit GPS proof'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),

                  // Requirement Box
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFEFEEEA),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.radar, color: Color(0xFF7D5800), size: 20),
                        const SizedBox(width: 10),
                        Text(
                          'Acceptable GPS Radius:',
                          style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13),
                        ),
                        const Spacer(),
                        Text(
                          '${quest.radiusMeters} meters',
                          style: GoogleFonts.plusJakartaSans(
                            color: const Color(0xFF1B1C1A),
                            fontWeight: FontWeight.bold,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 32),

                  // Launch AR Button
                  ElevatedButton.icon(
                    onPressed: () => _launchAR(context),
                    icon: const Icon(Icons.rocket_launch),
                    label: Text(
                      'Start Quest Experience',
                      style: GoogleFonts.epilogue(fontSize: 16, fontWeight: FontWeight.bold),
                    ),
                    style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(54),
                      backgroundColor: const Color(0xFFFFB703),
                      foregroundColor: const Color(0xFF6B4B00),
                      elevation: 3,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStepRow(String number, String text) {
    return Row(
      children: [
        Container(
          width: 24,
          height: 24,
          decoration: const BoxDecoration(
            color: Color(0xFFBEEAD1),
            shape: BoxShape.circle,
          ),
          child: Center(
            child: Text(
              number,
              style: GoogleFonts.plusJakartaSans(
                color: const Color(0xFF3F6653),
                fontWeight: FontWeight.bold,
                fontSize: 12,
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: GoogleFonts.plusJakartaSans(
              color: const Color(0xFF1B1C1A),
              fontSize: 13,
            ),
          ),
        ),
      ],
    );
  }
}
