import React from 'react';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useAuth } from '../context/AuthContext';
import { HygieneWorkflowView } from '../features/hygiene/HygieneWorkflow';

export function HygieneWorkflowScreen() {
  const navigation=useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {params}=useRoute<RouteProp<RootStackParamList,'HygieneWorkflow'>>();
  const {user}=useAuth();
  const insets=useSafeAreaInsets();
  return <HygieneWorkflowView initialDay={params?.day} operator={user??'Employé test'} onBack={()=>navigation.goBack()} topInset={insets.top} bottomInset={insets.bottom}/>;
}
