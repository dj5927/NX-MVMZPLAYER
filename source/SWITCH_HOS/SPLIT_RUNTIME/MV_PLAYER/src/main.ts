import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.66.0').catch(reportFatal);

