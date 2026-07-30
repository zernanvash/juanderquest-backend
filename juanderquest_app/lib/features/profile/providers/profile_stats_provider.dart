import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../submissions/providers/submission_provider.dart';
import '../../auth/providers/auth_provider.dart';

class ProfileStatsModel {
  final int completedQuestsCount;
  final int pendingSubmissionsCount;
  final int totalPointsEarned;
  final bool ecoPioneerUnlocked;
  final bool heritageKeeperUnlocked;
  final bool foodExplorerUnlocked;

  ProfileStatsModel({
    required this.completedQuestsCount,
    required this.pendingSubmissionsCount,
    required this.totalPointsEarned,
    required this.ecoPioneerUnlocked,
    required this.heritageKeeperUnlocked,
    required this.foodExplorerUnlocked,
  });
}

final profileStatsProvider = Provider<ProfileStatsModel>((ref) {
  final subState = ref.watch(submissionProvider);
  final user = ref.watch(authProvider).user;

  final approvedSubs = subState.submissions.where((s) => s.status == 'approved').toList();
  final pendingSubs = subState.submissions.where((s) => s.status == 'pending').toList();

  final hasEco = approvedSubs.any((s) => s.category.toLowerCase().contains('eco'));
  final hasCultural = approvedSubs.any((s) => s.category.toLowerCase().contains('cultural') || s.category.toLowerCase().contains('heritage'));
  final hasFood = approvedSubs.any((s) => s.category.toLowerCase().contains('food') || s.category.toLowerCase().contains('trade'));

  return ProfileStatsModel(
    completedQuestsCount: approvedSubs.length,
    pendingSubmissionsCount: pendingSubs.length,
    totalPointsEarned: user?.demoPoints ?? (approvedSubs.length * 50),
    ecoPioneerUnlocked: hasEco || approvedSubs.isNotEmpty,
    heritageKeeperUnlocked: hasCultural,
    foodExplorerUnlocked: hasFood,
  );
});
