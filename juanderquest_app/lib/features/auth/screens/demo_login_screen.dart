import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';

class DemoLoginScreen extends ConsumerStatefulWidget {
  const DemoLoginScreen({super.key});

  @override
  ConsumerState<DemoLoginScreen> createState() => _DemoLoginScreenState();
}

class _DemoLoginScreenState extends ConsumerState<DemoLoginScreen> {
  String _selectedSeed = 'user-1';

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);

    return Scaffold(
      backgroundColor: const Color(0xFF0A0F1D),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                width: 80,
                height: 80,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [Color(0xFF00F2FE), Color(0xFF4FACFE)],
                  ),
                  borderRadius: BorderRadius.circular(24),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x6600F2FE),
                      blurRadius: 20,
                      offset: Offset(0, 8),
                    ),
                  ],
                ),
                child: const Icon(
                  Icons.explore_rounded,
                  size: 48,
                  color: Color(0xFF0A0F1D),
                ),
              ),
              const SizedBox(height: 32),
              const Text(
                'JuanderQuest',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 32,
                  fontWeight: FontWeight.bold,
                  letterSpacing: -0.5,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Gamified Pangasinan Tourism Prototype',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Color(0xFF94A3B8),
                  fontSize: 14,
                ),
              ),
              const SizedBox(height: 48),
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: const Color(0xFF131B2E),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Colors.white.withOpacity(0.08)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Select Seeded Demo Profile',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: _selectedSeed,
                      dropdownColor: const Color(0xFF1C273E),
                      style: const TextStyle(color: Colors.white, fontSize: 15),
                      decoration: InputDecoration(
                        filled: true,
                        fillColor: const Color(0xFF1C273E),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: BorderSide.none,
                        ),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: 'user-1',
                          child: Text('Juan Dela Cruz (Traveler User)'),
                        ),
                        DropdownMenuItem(
                          value: 'admin-1',
                          child: Text('Pangasinan Admin (Administrator)'),
                        ),
                      ],
                      onChanged: (val) {
                        if (val != null) setState(() => _selectedSeed = val);
                      },
                    ),
                  ],
                ),
              ),
              if (authState.error != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF43F5E).withOpacity(0.15),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: const Color(0xFFF43F5E)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline, color: Color(0xFFF43F5E), size: 20),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          authState.error!,
                          style: const TextStyle(color: Color(0xFFF43F5E), fontSize: 13),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: authState.isLoading
                    ? null
                    : () async {
                        final router = GoRouter.of(context);
                        final success = await ref
                            .read(authProvider.notifier)
                            .loginWithSeed(_selectedSeed);
                        if (success) {
                          router.go('/quests');
                        }
                      },
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: const Color(0xFF00F2FE),
                  foregroundColor: const Color(0xFF0A0F1D),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  elevation: 4,
                ),
                child: authState.isLoading
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF0A0F1D)),
                      )
                    : const Text(
                        'Start Demo Experience',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
