import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../auth/providers/auth_provider.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authProvider).user;

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

            // Off-Chain Demo Points Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFFFB703)),
                boxShadow: [
                  BoxShadow(
                    color: const Color(0xFFFFB703).withValues(alpha: 0.15),
                    blurRadius: 10,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'PROTOTYPE REWARDS',
                        style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Demo Points Balance',
                        style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                    ],
                  ),
                  Row(
                    children: [
                      Image.asset(
                        'assets/images/jdq-token.png',
                        width: 32,
                        height: 32,
                        errorBuilder: (_, __, ___) => const Icon(Icons.stars, color: Color(0xFFFFB703), size: 32),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '${user?.demoPoints ?? 0}',
                        style: GoogleFonts.epilogue(color: const Color(0xFF7D5800), fontSize: 28, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),

            // Achievement Section Card
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
                        'Achievements',
                        style: GoogleFonts.epilogue(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFFEFEEEA),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          'FUTURE FEATURE',
                          style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 9, fontWeight: FontWeight.bold),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildBadgeItem(Icons.eco, 'Eco Pioneer'),
                      _buildBadgeItem(Icons.museum, 'Heritage Keeper'),
                      _buildBadgeItem(Icons.restaurant, 'Food Explorer'),
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
          currentIndex: 2,
          elevation: 0,
          onTap: (index) {
            if (index == 0) context.go('/quests');
            if (index == 1) context.go('/history');
          },
          items: const [
            BottomNavigationBarItem(icon: Icon(Icons.explore), label: 'Quests'),
            BottomNavigationBarItem(icon: Icon(Icons.history), label: 'Submissions'),
            BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
          ],
        ),
      ),
    );
  }

  Widget _buildBadgeItem(IconData icon, String label) {
    return Column(
      children: [
        Container(
          width: 54,
          height: 54,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: const Color(0xFFEFEEEA),
            border: Border.all(color: const Color(0xFFD5C4AC)),
          ),
          child: Icon(icon, color: const Color(0xFF837560), size: 26),
        ),
        const SizedBox(height: 6),
        Text(
          label,
          style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 11, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}
