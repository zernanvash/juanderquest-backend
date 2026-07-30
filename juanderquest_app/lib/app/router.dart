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
import '../features/map/screens/map_view_screen.dart';
import '../features/vote/screens/vote_screen.dart';
import '../features/shop/screens/shop_screen.dart';
import 'main_shell.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final refreshNotifier = ref.watch(authRefreshProvider);

  return GoRouter(
    initialLocation: '/',
    refreshListenable: refreshNotifier,
    redirect: (context, state) {
      final authState = ref.read(authProvider);
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
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) => MainShell(navigationShell: navigationShell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/quests',
                builder: (context, state) => const QuestListScreen(),
                routes: [
                  GoRoute(
                    path: ':id',
                    builder: (context, state) {
                      final quest = state.extra as QuestModel?;
                      if (quest != null) return QuestDetailScreen(quest: quest);
                      return QuestDetailScreen(questId: state.pathParameters['id'] ?? '');
                    },
                    routes: [
                      GoRoute(
                        path: 'ar',
                        builder: (context, state) {
                          final quest = state.extra as QuestModel?;
                          if (quest != null) return ARExperienceScreen(quest: quest);
                          return QuestDetailScreen(questId: state.pathParameters['id'] ?? '');
                        },
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/map',
                builder: (context, state) => const MapViewScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/vote',
                builder: (context, state) => const VoteScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/shop',
                builder: (context, state) => const ShopScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/profile',
                builder: (context, state) => const ProfileScreen(),
              ),
            ],
          ),
        ],
      ),
      GoRoute(
        path: '/history',
        builder: (context, state) => const SubmissionHistoryScreen(),
      ),
    ],
  );
});
