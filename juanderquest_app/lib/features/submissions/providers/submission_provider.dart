import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';
import '../../../core/network/api_client.dart';
import '../../auth/providers/auth_provider.dart';
import '../models/submission_model.dart';

class SubmissionState {
  final List<SubmissionModel> submissions;
  final bool isSubmitting;
  final bool isLoading;
  final String? error;

  SubmissionState({
    this.submissions = const [],
    this.isSubmitting = false,
    this.isLoading = false,
    this.error,
  });
}

class SubmissionNotifier extends StateNotifier<SubmissionState> {
  final ApiClient _apiClient;
  final _uuid = const Uuid();

  SubmissionNotifier(this._apiClient) : super(SubmissionState());

  Future<bool> submitProof({
    required String questId,
    required String markerCode,
    required double capturedLat,
    required double capturedLng,
    required double accuracy,
  }) async {
    state = SubmissionState(submissions: state.submissions, isSubmitting: true);
    try {
      final idempotencyKey = _uuid.v4();
      final response = await _apiClient.dio.post(
        '/submissions',
        data: {
          'idempotency_key': idempotencyKey,
          'quest_id': questId,
          'scanned_marker_code': markerCode,
          'captured_lat': capturedLat,
          'captured_lng': capturedLng,
          'captured_accuracy': accuracy,
        },
      );

      if (response.statusCode == 201 || response.statusCode == 200) {
        await fetchSubmissions();
        return true;
      } else {
        final msg = response.data['error']?['message'] ?? 'Submission rejected.';
        state = SubmissionState(submissions: state.submissions, error: msg);
        return false;
      }
    } on DioException catch (e) {
      final msg = e.response?.data['error']?['message'] ?? 'Network error: ${e.message}';
      state = SubmissionState(submissions: state.submissions, error: msg);
      return false;
    } catch (e) {
      state = SubmissionState(submissions: state.submissions, error: 'Unexpected error during submission.');
      return false;
    }
  }

  Future<void> fetchSubmissions() async {
    state = SubmissionState(submissions: state.submissions, isLoading: true);
    try {
      final response = await _apiClient.dio.get('/submissions');
      if (response.statusCode == 200 && response.data['success'] == true) {
        final list = (response.data['data'] as List)
            .map((s) => SubmissionModel.fromJson(s))
            .toList();
        state = SubmissionState(submissions: list);
      }
    } catch (e) {
      state = SubmissionState(submissions: state.submissions, error: 'Failed to fetch submissions.');
    }
  }
}

final submissionProvider = StateNotifierProvider<SubmissionNotifier, SubmissionState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return SubmissionNotifier(apiClient);
});
