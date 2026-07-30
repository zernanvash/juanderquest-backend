import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
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
          const SnackBar(
            content: Text('Camera and Location permissions are required to launch AR.'),
            backgroundColor: Color(0xFFF43F5E),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0A0F1D),
      appBar: AppBar(
        backgroundColor: const Color(0xFF131B2E),
        title: Text(quest.title, style: const TextStyle(fontSize: 16)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      body: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              height: 220,
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [Color(0xFF131B2E), Color(0xFF1C273E)],
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                ),
              ),
              child: Stack(
                children: [
                  Center(
                    child: Icon(
                      Icons.landscape_rounded,
                      size: 100,
                      color: const Color(0xFF00F2FE).withOpacity(0.3),
                    ),
                  ),
                  Positioned(
                    bottom: 16,
                    left: 16,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      decoration: BoxDecoration(
                        color: const Color(0xFF00F2FE),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        quest.category.toUpperCase(),
                        style: const TextStyle(
                          color: Color(0xFF0A0F1D),
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
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
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          quest.title,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 22,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFB703).withOpacity(0.15),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: const Color(0xFFFFB703)),
                        ),
                        child: Text(
                          '+${quest.rewardPoints} Pts',
                          style: const TextStyle(
                            color: Color(0xFFFFB703),
                            fontWeight: FontWeight.bold,
                            fontSize: 14,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      const Icon(Icons.location_on, color: Color(0xFF00F2FE), size: 16),
                      const SizedBox(width: 6),
                      Text(
                        quest.locationName,
                        style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 14),
                      ),
                    ],
                  ),
                  const Divider(color: Color(0xFF1C273E), height: 32),
                  const Text(
                    'Quest Instructions',
                    style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    quest.description,
                    style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 14, height: 1.5),
                  ),
                  const SizedBox(height: 24),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xFF131B2E),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.white.withOpacity(0.08)),
                    ),
                    child: Column(
                      children: [
                        _buildRequirementRow(Icons.qr_code_scanner, 'Target Marker', quest.markerCode),
                        const SizedBox(height: 8),
                        _buildRequirementRow(Icons.radar, 'Acceptable Radius', '${quest.radiusMeters} meters'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 32),
                  ElevatedButton.icon(
                    onPressed: () => _launchAR(context),
                    icon: const Icon(Icons.view_in_ar_rounded),
                    label: const Text('Launch AR Camera Experience'),
                    style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(54),
                      backgroundColor: const Color(0xFF00F2FE),
                      foregroundColor: const Color(0xFF0A0F1D),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
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

  Widget _buildRequirementRow(IconData icon, String label, String value) {
    return Row(
      children: [
        Icon(icon, color: const Color(0xFF00F2FE), size: 18),
        const SizedBox(width: 10),
        Text(label, style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 13)),
        const Spacer(),
        Text(value, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
      ],
    );
  }
}
