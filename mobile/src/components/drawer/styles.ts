import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  profileSection: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  profileTextWrap: {
    flex: 1,
  },
  displayName: {
    fontSize: 16,
    fontWeight: '600',
  },
  username: {
    fontSize: 13,
    marginTop: 2,
  },
  serverPickerHint: {
    fontSize: 12,
    marginTop: 4,
  },
  divider: {
    height: 1,
    marginHorizontal: 20,
  },
  navSection: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    gap: 14,
  },
  navItemText: {
    fontSize: 15,
    fontWeight: '400',
    flexShrink: 1,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingRight: 6,
  },
  labelNavItem: {
    flex: 1,
    paddingRight: 8,
  },
  labelMenuButton: {
    padding: 10,
    borderRadius: 8,
  },
  labelCount: {
    minWidth: 24,
    textAlign: 'right',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 6,
  },
  navDivider: {
    height: 1,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  bottomSection: {
    paddingTop: 0,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 16,
  },
  modalButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalSecondaryButton: {
    borderWidth: 1,
  },
  modalButtonDisabled: {
    opacity: 0.5,
  },
  modalPrimaryText: {
    color: '#fff',
    fontWeight: '600',
  },
  modalSecondaryText: {
    fontWeight: '500',
  },
  serverList: {
    marginBottom: 12,
    gap: 8,
  },
  serverRow: {
    borderWidth: 1,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  serverRowPressable: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  serverRowIconButton: {
    paddingRight: 12,
    paddingVertical: 10,
  },
  serverRowContent: {
    flex: 1,
  },
  serverRowTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  serverRowSubtext: {
    fontSize: 12,
    marginTop: 2,
  },
  serverSetupActions: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  serverSetupPending: {
    marginLeft: 12,
  },
  bottomNavButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 14,
  },
  bottomNavText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
