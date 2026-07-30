import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../features/auth/providers/auth_provider.dart';
import '../features/auth/screens/demo_login_screen.dart';
import '../features/quests/screens/quest_list_screen.dart';
import '../features/quests/screens/quest_detail_screen.dart';
import '../features/quests/models/quest_model.dart';
import '../features/ar_experience/screens/ar_experience_screen.dart';
import '../features/submissions/screens/submission_history_screen.dart';
import '../features/profile/screens/profile_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authProvider);

  return GoRouter(
    initialLocation: '/',
    redirect: (context, state) {
      final loggedIn = authState.isAuthenticated;
      final onLogin = state.matchedLocation == '/';

      if (!loggedIn && !onLogin) return '/';
      if (loggedIn && onLogin) return '/quests';
      return null;
    },
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
          final quest = state.extra as QuestModel?;
          if (quest == null) return const QuestListScreen();
          return QuestDetailScreen(quest: quest);
        },
      ),
      GoRoute(
        path: '/ar',
        builder: (context, state) {
          final quest = state.extra as QuestModel?;
          if (quest == null) return const QuestListScreen();
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
});
