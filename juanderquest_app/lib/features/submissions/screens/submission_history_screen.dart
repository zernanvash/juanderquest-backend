import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
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
      backgroundColor: const Color(0xFF0A0F1D),
      appBar: AppBar(
        backgroundColor: const Color(0xFF131B2E),
        elevation: 0,
        title: const Text('My Submissions History', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
      ),
      body: subState.isLoading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF00F2FE)))
          : subState.submissions.isEmpty
              ? const Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.history_rounded, size: 64, color: Color(0xFF64748B)),
                      SizedBox(height: 12),
                      Text('No submissions yet', style: TextStyle(color: Color(0xFF94A3B8), fontSize: 16)),
                    ],
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
      bottomNavigationBar: BottomNavigationBar(
        backgroundColor: const Color(0xFF131B2E),
        selectedItemColor: const Color(0xFF00F2FE),
        unselectedItemColor: const Color(0xFF64748B),
        currentIndex: 1,
        onTap: (index) {
          if (index == 0) context.go('/quests');
          if (index == 2) context.go('/profile');
        },
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.map), label: 'Quests'),
          BottomNavigationBarItem(icon: Icon(Icons.history), label: 'Submissions'),
          BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }

  Widget _buildSubmissionCard(SubmissionModel sub) {
    Color statusColor;
    String statusLabel;

    if (sub.status == 'approved') {
      statusColor = const Color(0xFF10B981);
      statusLabel = 'APPROVED (+${sub.rewardPoints} PTS)';
    } else if (sub.status == 'rejected') {
      statusColor = const Color(0xFFF43F5E);
      statusLabel = 'REJECTED';
    } else {
      statusColor = const Color(0xFFFFB703);
      statusLabel = 'PENDING ADMIN REVIEW';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF1C273E),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withOpacity(0.08)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                sub.questTitle,
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: statusColor.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  statusLabel,
                  style: TextStyle(color: statusColor, fontWeight: FontWeight.bold, fontSize: 10),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Submitted: ${sub.createdAt.substring(0, 10)}',
            style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 12),
          ),
          if (sub.rejectionReason != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFFF43F5E).withOpacity(0.1),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                'Reason: ${sub.rejectionReason}',
                style: const TextStyle(color: Color(0xFFF43F5E), fontSize: 12),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
