# Vue Options API 프로젝트 규칙

Vue 3 + Options API 기반 프로젝트에서 적용되는 규칙입니다.

---

## 환경 제약

- **JavaScript only** (TypeScript 사용 금지)
- Vue 3 + Options API 스타일 유지
- 신규 컴포넌트는 Composition API 권장 (강제 아님)

---

## 아키텍처 규칙

### 컴포넌트 크기 제한
- **단일 컴포넌트 최대 500줄** (template + script + style 합계)
- 500줄 초과 시 반드시 하위 컴포넌트로 분리
- 모달, 폼 섹션, 테이블은 별도 컴포넌트로 추출

### 대형 컴포넌트 분해 패턴
```bash
# 예: LargeComponent.vue (7,000줄+) 분해 방법
src/views/LargeComponent/
├── index.vue                    # 메인 (500줄 이하)
├── components/
│   ├── SectionA.vue
│   ├── SectionB.vue
│   └── ModalX.vue
└── composables/
    ├── useFeatureA.js
    └── useFeatureB.js
```

---

## Composables 사용 원칙 (Mixin 대체)

- **신규 코드에서 Mixin 사용 금지**
- 공유 로직은 `src/composables/` 폴더에 composable로 작성
- 네이밍: `use[기능명].js` (예: `useFormValidation.js`)
- 하나의 composable은 하나의 책임만 담당

```javascript
// ❌ 금지: Mixin 사용
export const formMixin = {
  data() { /* 모든 데이터 */ },
  methods: { /* 모든 메서드 */ }
}

// ✅ 권장: Composable 사용
// src/composables/useFormValidation.js
import { ref, computed } from 'vue'

export function useFormValidation() {
  const errors = ref({})

  const validate = (rules, data) => {
    // 검증 로직
  }

  const hasErrors = computed(() => Object.keys(errors.value).length > 0)

  return { errors, validate, hasErrors }
}
```

---

## API 서비스 레이어 규칙

- **뷰에서 axios 직접 import 금지** (신규 코드)
- `src/api/` 폴더의 서비스 함수 사용
- 모든 API 호출은 try-catch로 감싸기

```javascript
// src/api/index.js - axios 인스턴스
import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_APP_SERVERURL
})

api.interceptors.response.use(
  response => response,
  error => {
    // 공통 에러 처리
    return Promise.reject(error)
  }
)

export default api

// src/api/user.js - 도메인별 API
import api from './index'

export const userApi = {
  getList: (params) => api.get('/user/list', { params }),
  getDetail: (id) => api.get(`/user/${id}`),
  save: (data) => api.post('/user/save', data),
}

// 뷰에서 사용
import { userApi } from '@/api/user'

const response = await userApi.getList({ page: 1 })
```

---

## Vue 3 반응성 주의사항

### 배열 요소 수정
Vue 3에서 배열 요소 수정 시 반드시 직접 인덱스 접근 사용.

```javascript
// ❌ Wrong: Vue가 변경 감지 못함
const record = this.myArray[i];
record.field = newValue;

// ✅ Correct: Vue가 정상 추적
this.myArray[i].field = newValue;
```

---

## 점진적 마이그레이션 전략

- **신규 컴포넌트**: Composition API + `<script setup>` 사용
- **기존 컴포넌트**: 수정 시 점진적 전환 (강제 전환 불필요)
- Options API 유지해도 됨 (동작하는 코드 우선)

---

## 코드 품질 체크리스트

새 코드 작성/수정 시 확인:
- [ ] 컴포넌트 500줄 이하인가?
- [ ] API 호출이 서비스 레이어를 통하는가?
- [ ] 공유 로직이 composable로 분리되었는가?
- [ ] try-catch로 에러 처리가 되어있는가?
