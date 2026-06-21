import { Platform, StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 40,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
  },
  section: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  primaryButton: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 20,
  },
  importSelectButton: {
    marginTop: 0,
    borderWidth: 1,
  },
  importSelectButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
  importFileTypesText: {
    fontSize: 12,
    marginTop: 8,
  },
  importFileName: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 12,
  },
  importResultText: {
    marginTop: 12,
  },
  importErrorsContainer: {
    marginTop: 8,
    gap: 4,
  },
  importErrorItem: {
    marginTop: 0,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 13,
    marginTop: 8,
  },
  successText: {
    color: '#22c55e',
    fontSize: 13,
    marginTop: 8,
  },
  profileIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  profileAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  profileAvatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileAvatarText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
  },
  profileIconActions: {
    gap: 8,
  },
  uploadButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  uploadButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  removeIconButton: {
    paddingVertical: 4,
  },
  removeIconText: {
    fontSize: 14,
    fontWeight: '500',
  },
  dropdownTrigger: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownTriggerText: {
    fontSize: 14,
    fontWeight: '500',
  },
  dropdownOverlay: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  dropdownMenu: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    maxHeight: '70%',
  },
  dropdownOptionsList: {
    maxHeight: '100%',
  },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  dropdownOptionText: {
    fontSize: 15,
    fontWeight: '500',
  },
  preferenceLabel: {
    marginTop: 16,
  },
  aboutToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  aboutToggleText: {
    fontSize: 15,
    fontWeight: '500',
  },
  aboutContent: {
    marginTop: 12,
  },
  aboutSection: {
    gap: 4,
  },
  aboutSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  aboutDivider: {
    height: 1,
    marginVertical: 12,
  },
  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
    gap: 8,
  },
  aboutLabel: {
    fontSize: 13,
    flexShrink: 0,
  },
  aboutValue: {
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flexShrink: 1,
    textAlign: 'right',
  },
  sessionsDescription: {
    fontSize: 13,
    marginBottom: 12,
  },
  sessionsLoader: {
    marginVertical: 8,
  },
  sessionsList: {
    gap: 8,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sessionInfo: {
    flex: 1,
    marginRight: 8,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sessionBrowser: {
    fontSize: 14,
    fontWeight: '500',
  },
  currentBadge: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  currentBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  sessionDate: {
    fontSize: 12,
    marginTop: 2,
  },
  revokeButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  revokeText: {
    fontSize: 14,
    fontWeight: '500',
  },
  patCreateRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  patNameInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  patCreateButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  patCreateButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
