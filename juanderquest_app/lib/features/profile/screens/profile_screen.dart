import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/profile_stats_provider.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authProvider).user;
    final stats = ref.watch(profileStatsProvider);

    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          'Traveler Profile',
          style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontSize: 20, fontWeight: FontWeight.bold),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          children: [
            Center(
              child: Column(
                children: [
                  Container(
                    width: 84,
                    height: 84,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: const Color(0xFFFFB703), width: 3),
                      image: DecorationImage(
                        image: NetworkImage(
                          user?.avatarUrl.isNotEmpty == true
                              ? user!.avatarUrl
                              : 'https://api.dicebear.com/7.x/avataaars/svg?seed=Juan',
                        ),
                        fit: BoxFit.cover,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    user?.displayName ?? 'Juan Dela Cruz',
                    style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontSize: 22, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    user?.email ?? 'juan@juanderquest.ph',
                    style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13),
                  ),
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF3F6653).withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      'PANGASINAN EXPLORER',
                      style: GoogleFonts.plusJakartaSans(color: const Color(0xFF3F6653), fontWeight: FontWeight.bold, fontSize: 10),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // Computed Traveler Statistics Card
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.03),
                    blurRadius: 8,
                    offset: const Offset(0, 3),
                  ),
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  _buildStatItem('Completed', '${stats.completedQuestsCount}', Icons.check_circle_outline, const Color(0xFF2D6A4F)),
                  const SizedBox(width: 8),
                  _buildStatItem('Pending', '${stats.pendingSubmissionsCount}', Icons.hourglass_top_rounded, const Color(0xFFFFB703)),
                  const SizedBox(width: 8),
                  _buildStatItem('Points', '${stats.totalPointsEarned}', Icons.stars, const Color(0xFF7D5800)),
                ],
              ),
            ),

            const SizedBox(height: 16),

            // Submissions & Proof History Action Tile
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
              ),
              child: ListTile(
                leading: Container(
                  width: 40,
                  height: 40,
                  decoration: const BoxDecoration(
                    color: Color(0xFFEFEEEA),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.history_rounded, color: Color(0xFF7D5800)),
                ),
                title: Text(
                  'Submissions & Proof History',
                  style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 15),
                ),
                subtitle: Text(
                  'View review status of submitted quest proofs',
                  style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
                ),
                trailing: const Icon(Icons.chevron_right, color: Color(0xFF837560)),
                onTap: () => context.push('/history'),
              ),
            ),

            const SizedBox(height: 24),

            // Live Achievements Section Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'Explorer Badges',
                        style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFFBEEAD1),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          'LIVE PROGRESS',
                          style: GoogleFonts.plusJakartaSans(color: const Color(0xFF436B58), fontSize: 9, fontWeight: FontWeight.bold),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildAchievementBadge(Icons.eco, 'Eco Pioneer', stats.ecoPioneerUnlocked),
                      _buildAchievementBadge(Icons.museum, 'Heritage Keeper', stats.heritageKeeperUnlocked),
                      _buildAchievementBadge(Icons.restaurant, 'Food Explorer', stats.foodExplorerUnlocked),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 32),

            // Logout Button
            ElevatedButton.icon(
              onPressed: () {
                ref.read(authProvider.notifier).logout();
                context.go('/');
              },
              icon: const Icon(Icons.logout),
              label: Text('Logout', style: GoogleFonts.epilogue(fontWeight: FontWeight.bold)),
              style: ElevatedButton.styleFrom(
                minimumSize: const Size.fromHeight(50),
                backgroundColor: const Color(0xFFBC4749).withValues(alpha: 0.15),
                foregroundColor: const Color(0xFFBC4749),
                elevation: 0,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border(top: BorderSide(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4))),
        ),
        child: BottomNavigationBar(
          backgroundColor: Colors.white,
          selectedItemColor: const Color(0xFF3F6653),
          unselectedItemColor: const Color(0xFF837560),
          currentIndex: 4,
          type: BottomNavigationBarType.fixed,
          elevation: 0,
          onTap: (index) {
            if (index == 0) context.go('/quests');
            if (index == 1) context.go('/map');
            if (index == 2) context.go('/vote');
            if (index == 3) context.go('/shop');
          },
          items: const [
            BottomNavigationBarItem(icon: Icon(Icons.home_rounded), label: 'Home'),
            BottomNavigationBarItem(icon: Icon(Icons.map_rounded), label: 'Map'),
            BottomNavigationBarItem(icon: Icon(Icons.how_to_vote_rounded), label: 'Vote'),
            BottomNavigationBarItem(icon: Icon(Icons.storefront_rounded), label: 'Shop'),
            BottomNavigationBarItem(icon: Icon(Icons.person_rounded), label: 'Profile'),
          ],
        ),
      ),
    );
  }

  Widget _buildStatItem(String label, String value, IconData icon, Color color) {
    return Expanded(
      child: Column(
        children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(height: 4),
          Text(
            value,
            style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontSize: 18, fontWeight: FontWeight.bold),
          ),
          Text(
            label,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 11),
          ),
        ],
      ),
    );
  }

  Widget _buildAchievementBadge(IconData icon, String label, bool isUnlocked) {
    return Expanded(
      child: Column(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: isUnlocked ? const Color(0xFFFFB703).withValues(alpha: 0.2) : const Color(0xFFEFEEEA),
              border: Border.all(
                color: isUnlocked ? const Color(0xFFFFB703) : const Color(0xFFD5C4AC),
                width: isUnlocked ? 2 : 1,
              ),
            ),
            child: Icon(
              icon,
              color: isUnlocked ? const Color(0xFF7D5800) : const Color(0xFF837560).withValues(alpha: 0.5),
              size: 26,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            label,
            textAlign: TextAlign.center,
            style: GoogleFonts.plusJakartaSans(
              color: isUnlocked ? const Color(0xFF1B1C1A) : const Color(0xFF837560),
              fontSize: 11,
              fontWeight: isUnlocked ? FontWeight.bold : FontWeight.normal,
            ),
          ),
        ],
      ),
    );
  }
}
