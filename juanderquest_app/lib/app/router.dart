import 'package:go_router/go_router.dart';
import '../features/auth/screens/demo_login_screen.dart';
import '../features/quests/screens/quest_list_screen.dart';
import '../features/quests/screens/quest_detail_screen.dart';
import '../features/quests/models/quest_model.dart';
import '../features/ar_experience/screens/ar_experience_screen.dart';
import '../features/submissions/screens/submission_history_screen.dart';
import '../features/profile/screens/profile_screen.dart';

final GoRouter appRouter = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const DemoLoginScreen(),
    ),
    GoRoute(
      path: '/quests',
      builder: (context, state) => const QuestListScreen(),
    ),
    GoRoute(
      path: '/quests/:id',
      builder: (context, state) {
        final quest = state.extra as QuestModel;
        return QuestDetailScreen(quest: quest);
      },
    ),
    GoRoute(
      path: '/ar',
      builder: (context, state) {
        final quest = state.extra as QuestModel;
        return ARExperienceScreen(quest: quest);
      },
    ),
    GoRoute(
      path: '/history',
      builder: (context, state) => const SubmissionHistoryScreen(),
    ),
    GoRoute(
      path: '/profile',
      builder: (context, state) => const ProfileScreen(),
    ),
  ],
);
