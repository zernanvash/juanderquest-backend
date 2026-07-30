import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import '../providers/auth_provider.dart';

class DemoLoginScreen extends ConsumerStatefulWidget {
  const DemoLoginScreen({super.key});

  @override
  ConsumerState<DemoLoginScreen> createState() => _DemoLoginScreenState();
}

class _DemoLoginScreenState extends ConsumerState<DemoLoginScreen> {
  String _selectedRole = 'traveler'; // 'traveler' or 'admin'

  String get _selectedSeed => _selectedRole == 'admin' ? 'admin-1' : 'user-1';

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);

    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 20.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 12),
                // Logo Image Header
                Center(
                  child: Image.asset(
                    'assets/images/logo.png',
                    height: 140,
                    fit: BoxFit.contain,
                    errorBuilder: (_, __, ___) => Column(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: const Color(0xFFFFB703),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: const Icon(Icons.explore, size: 48, color: Color(0xFF582F0E)),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'JuanderQuest',
                          style: GoogleFonts.epilogue(
                            fontSize: 28,
                            fontWeight: FontWeight.bold,
                            color: const Color(0xFF582F0E),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 24),

                // Product Description Glass Card
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFF582F0E).withValues(alpha: 0.1)),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.03),
                        blurRadius: 10,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Column(
                    children: [
                      Text(
                        "PANGASINAN'S HERITAGE QUEST",
                        style: GoogleFonts.plusJakartaSans(
                          color: const Color(0xFF582F0E),
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 1.2,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'A gamified tourism system promoting hidden destinations in Pangasinan. Explore destinations, complete quests, and earn demo rewards.',
                        textAlign: TextAlign.center,
                        style: GoogleFonts.plusJakartaSans(
                          color: const Color(0xFF514532),
                          fontSize: 13,
                          height: 1.5,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),

                // Role Selector Cards
                Row(
                  children: [
                    Expanded(
                      child: _buildRoleCard(
                        role: 'traveler',
                        title: 'Traveler',
                        subtitle: 'Explore Quests',
                        icon: Icons.map_outlined,
                        containerColor: const Color(0xFFBEEAD1),
                        iconColor: const Color(0xFF3F6653),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _buildRoleCard(
                        role: 'admin',
                        title: 'Admin',
                        subtitle: 'Manage Region',
                        icon: Icons.admin_panel_settings_outlined,
                        containerColor: const Color(0xFFFFDEA9),
                        iconColor: const Color(0xFF7D5800),
                      ),
                    ),
                  ],
                ),

                if (authState.error != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFBC4749).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: const Color(0xFFBC4749)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline, color: Color(0xFFBC4749), size: 20),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            authState.error!,
                            style: GoogleFonts.plusJakartaSans(color: const Color(0xFFBC4749), fontSize: 13),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                const SizedBox(height: 28),

                // Primary CTA Button
                ElevatedButton(
                  onPressed: authState.isLoading
                      ? null
                      : () {
                          ref.read(authProvider.notifier).loginWithSeed(_selectedSeed);
                        },
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    backgroundColor: const Color(0xFFFFB703),
                    foregroundColor: const Color(0xFF6B4B00),
                    elevation: 3,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  child: authState.isLoading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF6B4B00)),
                        )
                      : Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              'Start Demo Experience',
                              style: GoogleFonts.epilogue(fontSize: 16, fontWeight: FontWeight.bold),
                            ),
                            const SizedBox(width: 8),
                            const Icon(Icons.rocket_launch, size: 20),
                          ],
                        ),
                ),

                const SizedBox(height: 36),

                // Prototype Disclosure Footer
                Column(
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.info_outline, size: 14, color: Color(0xFF837560)),
                        const SizedBox(width: 4),
                        Text(
                          'PROTOTYPE BUILD V0.4.2',
                          style: GoogleFonts.plusJakartaSans(
                            color: const Color(0xFF837560),
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 0.8,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'This is a demonstration build. Wallet authentication and blockchain settlement are mocked for this presentation.',
                      textAlign: TextAlign.center,
                      style: GoogleFonts.plusJakartaSans(
                        color: const Color(0xFF837560),
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildRoleCard({
    required String role,
    required String title,
    required String subtitle,
    required IconData icon,
    required Color containerColor,
    required Color iconColor,
  }) {
    final isSelected = _selectedRole == role;

    return GestureDetector(
      onTap: () => setState(() => _selectedRole = role),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isSelected ? const Color(0xFFFFB703) : const Color(0xFFD5C4AC).withValues(alpha: 0.4),
            width: isSelected ? 2.5 : 1,
          ),
          boxShadow: isSelected
              ? [
                  BoxShadow(
                    color: const Color(0xFFFFB703).withValues(alpha: 0.25),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ]
              : [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.02),
                    blurRadius: 6,
                    offset: const Offset(0, 2),
                  ),
                ],
        ),
        child: Column(
          children: [
            Container(
              width: 54,
              height: 54,
              decoration: BoxDecoration(
                color: containerColor,
                shape: BoxShape.circle,
              ),
              child: Icon(icon, color: iconColor, size: 28),
            ),
            const SizedBox(height: 12),
            Text(
              title,
              style: GoogleFonts.plusJakartaSans(
                color: const Color(0xFF1B1C1A),
                fontSize: 15,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              subtitle,
              style: GoogleFonts.plusJakartaSans(
                color: const Color(0xFF514532),
                fontSize: 11,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
