import React from 'react';
import { render } from '@testing-library/react-native';
import UserAvatar from '../src/components/UserAvatar';

const mockUser = {
  id: 'user-1',
  username: 'johndoe',
  first_name: 'John',
  last_name: 'Doe',
  role: 'user',
  has_profile_icon: false,
};

describe('UserAvatar', () => {
  it('renders initials from first and last name', () => {
    const { getByText } = render(<UserAvatar user={mockUser} />);
    expect(getByText('JD')).toBeTruthy();
  });

  it('falls back to username initial when no name', () => {
    const user = { ...mockUser, first_name: '', last_name: '' };
    const { getByText } = render(<UserAvatar user={user} />);
    expect(getByText('J')).toBeTruthy();
  });

  it('uses the provided size', () => {
    const { getByRole } = render(<UserAvatar user={mockUser} size={60} />);
    const avatar = getByRole('image');
    expect(avatar.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ width: 60, height: 60, borderRadius: 30 }),
      ])
    );
  });
});
