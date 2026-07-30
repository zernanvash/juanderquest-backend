import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import '../../../core/network/api_client.dart';
import '../models/user_model.dart';

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient());

class AuthState {
  final UserModel? user;
  final String? token;
  final bool isLoading;
  final String? error;

  AuthState({
    this.user,
    this.token,
    this.isLoading = false,
    this.error,
  });

  bool get isAuthenticated => user != null && token != null;
}

class AuthNotifier extends StateNotifier<AuthState> {
  final ApiClient _apiClient;

  AuthNotifier(this._apiClient) : super(AuthState());

  Future<bool> loginWithSeed(String seedId) async {
    state = AuthState(isLoading: true);
    try {
      final response = await _apiClient.dio.post(
        '/auth/demo-login',
        data: {'seed_id': seedId},
      );

      if (response.statusCode == 200 && response.data['success'] == true) {
        final token = response.data['data']['token'] as String;
        final userJson = response.data['data']['user'];
        final user = UserModel.fromJson(userJson);

        _apiClient.setAuthToken(token);
        state = AuthState(user: user, token: token);
        return true;
      } else {
        final msg = response.data['error']?['message'] ?? 'Authentication failed.';
        state = AuthState(error: msg);
        return false;
      }
    } on DioException catch (e) {
      final msg = e.response?.data['error']?['message'] ?? 'Network connection error (${e.message}).';
      state = AuthState(error: msg);
      return false;
    } catch (e) {
      state = AuthState(error: 'An unexpected error occurred.');
      return false;
    }
  }

  Future<void> refreshProfile() async {
    if (state.token == null) return;
    try {
      final response = await _apiClient.dio.get('/auth/me');
      if (response.statusCode == 200 && response.data['success'] == true) {
        final user = UserModel.fromJson(response.data['data']);
        state = AuthState(user: user, token: state.token);
      }
    } catch (e) {
      print('Failed to refresh profile: $e');
    }
  }

  void logout() {
    _apiClient.setAuthToken(null);
    state = AuthState();
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return AuthNotifier(apiClient);
});
