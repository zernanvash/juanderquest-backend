import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../providers/submission_provider.dart';
import '../models/submission_model.dart';

class SubmissionHistoryScreen extends ConsumerStatefulWidget {
  const SubmissionHistoryScreen({super.key});

  @override
  ConsumerState<SubmissionHistoryScreen> createState() => _SubmissionHistoryScreenState();
}

class _SubmissionHistoryScreenState extends ConsumerState<SubmissionHistoryScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      ref.read(submissionProvider.notifier).fetchSubmissions();
    });
  }

  @override
  Widget build(BuildContext context) {
    final subState = ref.watch(submissionProvider);

    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          'Submission History',
          style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontSize: 20, fontWeight: FontWeight.bold),
        ),
      ),
      body: subState.isLoading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFFFFB703)))
          : subState.submissions.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32.0),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.history_rounded, size: 64, color: Color(0xFF837560)),
                        const SizedBox(height: 16),
                        Text(
                          'You have not submitted any quests yet.',
                          style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 15),
                        ),
                        const SizedBox(height: 20),
                        ElevatedButton(
                          onPressed: () => context.go('/quests'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFFFB703),
                            foregroundColor: const Color(0xFF6B4B00),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          ),
                          child: Text('Explore Quests', style: GoogleFonts.epilogue(fontWeight: FontWeight.bold)),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: subState.submissions.length,
                  itemBuilder: (context, index) {
                    final sub = subState.submissions[index];
                    return _buildSubmissionCard(sub);
                  },
                ),

    );
  }

  Widget _buildSubmissionCard(SubmissionModel sub) {
    Color statusBg;
    Color statusTextColor;
    String statusLabel;

    if (sub.status == 'approved') {
      statusBg = const Color(0xFF2D6A4F).withValues(alpha: 0.15);
      statusTextColor = const Color(0xFF2D6A4F);
      statusLabel = 'Quest approved — +${sub.rewardPoints} points awarded';
    } else if (sub.status == 'rejected') {
      statusBg = const Color(0xFFBC4749).withValues(alpha: 0.15);
      statusTextColor = const Color(0xFFBC4749);
      statusLabel = 'Proof rejected';
    } else {
      statusBg = const Color(0xFFFFB703).withValues(alpha: 0.2);
      statusTextColor = const Color(0xFF6B4B00);
      statusLabel = 'Awaiting administrator review';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.02),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(
                  sub.questTitle,
                  style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 16),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: statusBg,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  statusLabel,
                  style: GoogleFonts.plusJakartaSans(color: statusTextColor, fontWeight: FontWeight.bold, fontSize: 10),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Submitted: ${sub.createdAt.length >= 10 ? sub.createdAt.substring(0, 10) : sub.createdAt}',
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
          ),
          if (sub.rejectionReason != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFBC4749).withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                'Reason: ${sub.rejectionReason}',
                style: GoogleFonts.plusJakartaSans(color: const Color(0xFFBC4749), fontSize: 12),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
