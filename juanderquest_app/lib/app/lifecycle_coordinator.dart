import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../features/auth/providers/auth_provider.dart';
import '../features/submissions/providers/submission_provider.dart';

class LifecycleCoordinator extends StatefulWidget {
  final Widget child;

  const LifecycleCoordinator({super.key, required this.child});

  @override
  State<LifecycleCoordinator> createState() => _LifecycleCoordinatorState();
}

class _LifecycleCoordinatorState extends State<LifecycleCoordinator> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      final container = ProviderScope.containerOf(context, listen: false);
      final auth = container.read(authProvider);
      if (auth.isAuthenticated) {
        container.read(authProvider.notifier).refreshProfile();
        container.read(submissionProvider.notifier).fetchSubmissions();
      }
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
