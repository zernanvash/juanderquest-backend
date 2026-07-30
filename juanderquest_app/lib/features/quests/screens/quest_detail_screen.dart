import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:permission_handler/permission_handler.dart';
import '../../auth/providers/auth_provider.dart';
import '../../../core/widgets/error_dialog.dart';
import '../models/quest_model.dart';

class QuestDetailScreen extends ConsumerWidget {
  final QuestModel? quest;
  final String? questId;

  const QuestDetailScreen({super.key, this.quest, this.questId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (quest != null) return _DetailContent(quest: quest!);

    if (questId == null) return const _NotFound();

    return _QuestDetailById(questId: questId!);
  }
}

class _QuestDetailById extends ConsumerStatefulWidget {
  final String questId;
  const _QuestDetailById({required this.questId});

  @override
  ConsumerState<_QuestDetailById> createState() => _QuestDetailByIdState();
}

class _QuestDetailByIdState extends ConsumerState<_QuestDetailById> {
  Future<QuestModel?>? _fetchFuture;

  @override
  void initState() {
    super.initState();
    _fetchFuture = _fetchQuest();
  }

  Future<QuestModel?> _fetchQuest() async {
    try {
      final apiClient = ref.read(apiClientProvider);
      final response = await apiClient.dio.get('/quests/${widget.questId}');
      if (response.statusCode == 200 && response.data['success'] == true) {
        return QuestModel.fromJson(response.data['data']);
      }
    } catch (_) {}
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<QuestModel?>(
      future: _fetchFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator(color: Color(0xFFFFB703))),
          );
        }
        if (snapshot.data == null) return const _NotFound();
        return _DetailContent(quest: snapshot.data!);
      },
    );
  }
}

class _NotFound extends StatelessWidget {
  const _NotFound();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Color(0xFF582F0E)),
          onPressed: () => context.pop(),
        ),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.search_off, size: 64, color: Color(0xFF837560)),
            const SizedBox(height: 16),
            Text(
              'Quest Not Found',
              style: GoogleFonts.epilogue(fontSize: 20, fontWeight: FontWeight.bold, color: const Color(0xFF582F0E)),
            ),
            const SizedBox(height: 8),
            Text(
              'This quest could not be loaded.',
              style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532)),
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailContent extends StatelessWidget {
  final QuestModel quest;
  const _DetailContent({required this.quest});

  Future<void> _launchAR(BuildContext context) async {
    final cameraStatus = await Permission.camera.request();
    final locationStatus = await Permission.locationWhenInUse.request();

    if (cameraStatus.isGranted && locationStatus.isGranted) {
      if (context.mounted) {
        context.push('/quests/${quest.id}/ar', extra: quest);
      }
    } else {
      if (context.mounted) {
        GlobalErrorDialog.show(
          context,
          title: 'Permissions Required',
          message: 'JuanderQuest uses your camera to recognize destination markers and location services to verify quest completion radius.',
          icon: Icons.security_rounded,
          iconColor: const Color(0xFFBC4749),
          buttonText: 'Open Device Settings',
          onPressed: () => openAppSettings(),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      body: SafeArea(
        top: false,
        child: Stack(
          children: [
            SingleChildScrollView(
              padding: const EdgeInsets.only(bottom: 100),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Stack(
                    children: [
                      Container(
                        height: 300,
                        decoration: const BoxDecoration(
                          image: DecorationImage(
                            image: AssetImage('assets/images/pangasinan_banner.png'),
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                      Container(
                        height: 300,
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: [
                              Colors.black.withValues(alpha: 0.8),
                              Colors.black.withValues(alpha: 0.2),
                              Colors.transparent,
                            ],
                            begin: Alignment.bottomCenter,
                            end: Alignment.topCenter,
                          ),
                        ),
                      ),
                      Positioned(
                        top: 48,
                        left: 16,
                        right: 16,
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            CircleAvatar(
                              backgroundColor: Colors.white.withValues(alpha: 0.85),
                              child: IconButton(
                                icon: const Icon(Icons.arrow_back, color: Color(0xFF582F0E)),
                                onPressed: () => context.pop(),
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFFB703),
                                borderRadius: BorderRadius.circular(20),
                              ),
                              child: Row(
                                children: [
                                  const Icon(Icons.stars, size: 16, color: Color(0xFF6B4B00)),
                                  const SizedBox(width: 4),
                                  Text(
                                    '${quest.rewardPoints} PTS',
                                    style: GoogleFonts.plusJakartaSans(
                                      color: const Color(0xFF6B4B00),
                                      fontWeight: FontWeight.bold,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      Positioned(
                        bottom: 20,
                        left: 20,
                        right: 20,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFF7D5800),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(color: Colors.white.withValues(alpha: 0.3)),
                                  ),
                                  child: Text(
                                    quest.category.toUpperCase(),
                                    style: GoogleFonts.plusJakartaSans(
                                      color: Colors.white,
                                      fontWeight: FontWeight.bold,
                                      fontSize: 10,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFF3F6653),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(color: Colors.white.withValues(alpha: 0.3)),
                                  ),
                                  child: Text(
                                    '500 XP',
                                    style: GoogleFonts.plusJakartaSans(
                                      color: Colors.white,
                                      fontWeight: FontWeight.bold,
                                      fontSize: 10,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Text(
                              quest.title,
                              style: GoogleFonts.epilogue(
                                color: Colors.white,
                                fontSize: 26,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Row(
                              children: [
                                const Icon(Icons.location_on, color: Color(0xFFFFB703), size: 16),
                                const SizedBox(width: 4),
                                Text(
                                  quest.locationName,
                                  style: GoogleFonts.plusJakartaSans(
                                    color: Colors.white.withValues(alpha: 0.9),
                                    fontSize: 14,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  Transform.translate(
                    offset: const Offset(0, -16),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Container(
                        padding: const EdgeInsets.all(20),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                          boxShadow: [
                            BoxShadow(
                              color: const Color(0xFF582F0E).withValues(alpha: 0.06),
                              blurRadius: 16,
                              offset: const Offset(0, 4),
                            ),
                          ],
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text('CURRENT REWARD', style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1.0)),
                                    const SizedBox(height: 2),
                                    Row(
                                      children: [
                                        const Icon(Icons.monetization_on, color: Color(0xFFFFB703), size: 20),
                                        const SizedBox(width: 6),
                                        Text('${quest.rewardPoints} Quest Points', style: GoogleFonts.epilogue(color: const Color(0xFF7D5800), fontSize: 16, fontWeight: FontWeight.bold)),
                                      ],
                                    ),
                                  ],
                                ),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.end,
                                  children: [
                                    Text('DIFFICULTY', style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1.0)),
                                    const SizedBox(height: 2),
                                    Row(
                                      children: [
                                        const Icon(Icons.terrain, color: Color(0xFF582F0E), size: 16),
                                        const SizedBox(width: 4),
                                        Text('Moderate', style: GoogleFonts.plusJakartaSans(color: const Color(0xFF582F0E), fontSize: 14, fontWeight: FontWeight.bold)),
                                      ],
                                    ),
                                  ],
                                ),
                              ],
                            ),
                            const Divider(color: Color(0xFFD5C4AC), height: 24),
                            Text('Quest Overview', style: GoogleFonts.epilogue(color: const Color(0xFF0D1B2A), fontSize: 16, fontWeight: FontWeight.bold)),
                            const SizedBox(height: 8),
                            Text(quest.description, style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 14, height: 1.5)),
                          ],
                        ),
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Quest Objectives', style: GoogleFonts.epilogue(color: const Color(0xFF0D1B2A), fontSize: 18, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 12),
                        _buildRefinedObjectiveStep(stepNumber: '1', title: 'Visit Destination', subtitle: 'Arrive within ${quest.radiusMeters}m of the location.', icon: Icons.directions_walk, isCompleted: true),
                        const SizedBox(height: 10),
                        _buildRefinedObjectiveStep(stepNumber: '2', title: 'Locate Quest Marker', subtitle: 'Find and scan the heritage quest marker.', icon: Icons.qr_code_scanner, isCompleted: false),
                        const SizedBox(height: 10),
                        _buildRefinedObjectiveStep(stepNumber: '3', title: 'Submit GPS Proof', subtitle: 'Capture live AR photo and submit for review.', icon: Icons.camera_alt, isCompleted: false),
                        const SizedBox(height: 20),
                        Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(color: const Color(0xFF3F6653).withValues(alpha: 0.08), borderRadius: BorderRadius.circular(14), border: Border.all(color: const Color(0xFF3F6653).withValues(alpha: 0.2))),
                          child: Row(
                            children: [
                              const Icon(Icons.info, color: Color(0xFF3F6653), size: 20),
                              const SizedBox(width: 10),
                              Expanded(
                                child: RichText(
                                  text: TextSpan(
                                    style: GoogleFonts.plusJakartaSans(color: const Color(0xFF436B58), fontSize: 12, height: 1.4),
                                    children: const [
                                      TextSpan(text: 'Local Tip: ', style: TextStyle(fontWeight: FontWeight.bold)),
                                      TextSpan(text: 'Visit between 5:00 PM and 6:00 PM to capture golden hour lighting at this destination.'),
                                    ],
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Positioned(
              bottom: 0, left: 0, right: 0,
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.95), boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 12, offset: const Offset(0, -4))]),
                child: Container(
                  height: 54,
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), gradient: const LinearGradient(colors: [Color(0xFF7D5800), Color(0xFF582F0E)], begin: Alignment.topLeft, end: Alignment.bottomRight), boxShadow: [BoxShadow(color: const Color(0xFF582F0E).withValues(alpha: 0.3), blurRadius: 10, offset: const Offset(0, 4))]),
                  child: ElevatedButton.icon(
                    onPressed: () => _launchAR(context),
                    icon: const Icon(Icons.play_arrow, color: Colors.white),
                    label: Text('Start Quest Experience', style: GoogleFonts.epilogue(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold)),
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.transparent, shadowColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRefinedObjectiveStep({required String stepNumber, required String title, required String subtitle, required IconData icon, required bool isCompleted}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: isCompleted ? Colors.white : const Color(0xFFF4F4F0), borderRadius: BorderRadius.circular(16), border: Border.all(color: isCompleted ? const Color(0xFF2D6A4F).withValues(alpha: 0.4) : const Color(0xFFD5C4AC).withValues(alpha: 0.3), width: isCompleted ? 1.5 : 1)),
      child: Row(
        children: [
          Container(
            width: 44, height: 44,
            decoration: BoxDecoration(color: isCompleted ? const Color(0xFF2D6A4F).withValues(alpha: 0.15) : const Color(0xFF7D5800).withValues(alpha: 0.1), shape: BoxShape.circle),
            child: Icon(icon, color: isCompleted ? const Color(0xFF2D6A4F) : const Color(0xFF7D5800), size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Step $stepNumber: $title', style: GoogleFonts.plusJakartaSans(color: const Color(0xFF1B1C1A), fontSize: 14, fontWeight: FontWeight.bold)),
                Text(subtitle, style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 12)),
              ],
            ),
          ),
          if (isCompleted) const Icon(Icons.check_circle, color: Color(0xFF2D6A4F), size: 22) else const Icon(Icons.radio_button_unchecked, color: Color(0xFF837560), size: 20),
        ],
      ),
    );
  }
}
